// src/utils/media/imageUtils.js
const sharp = require('sharp');
const { createTempPath } = require('./tempFiles');
const { runFFmpeg, mp4OutputOptions } = require('./ffmpegUtils');
const { isGifInput, staticImageFormatForExt, applySharpFormat } = require('./formatHelpers');

async function gifFilter(inputPath, filter, outputExt = 'gif') {
    const outputPath = createTempPath(outputExt);
    await runFFmpeg(inputPath, outputPath, cmd => {
        cmd
            .videoFilters(filter)
            .outputOptions([
                '-an',
                '-loop 0',
                '-gifflags -offsetting',
            ]);
    });
    return outputPath;
}

async function videoFilter(inputPath, filter) {
    const outputPath = createTempPath('mp4');
    const outputOptions = await mp4OutputOptions(inputPath, {
        targetBytes: 16 * 1024 * 1024,
        qualityMultiplier: 1.55,
        maxVideoKbps: 2200,
        maxAudioKbps: 80,
    });
    await runFFmpeg(inputPath, outputPath, cmd => {
        cmd
            .videoFilters(`${filter},scale=ceil(iw/2)*2:ceil(ih/2)*2`)
            .outputOptions(outputOptions);
    });
    return outputPath;
}

async function writeStaticImage(pipeline, inputExt, formatOverrides = {}) {
    const formatInfo = staticImageFormatForExt(inputExt);
    const outputPath = createTempPath(formatInfo.ext);
    await applySharpFormat(pipeline, formatInfo, formatOverrides).toFile(outputPath);
    return outputPath;
}

// Convert an image to the specified format (png, jpeg, webp, gif, avif)
async function toFormat(inputPath, format, options = {}, inputExt = '', mediaContext = {}) {
    const outputExt = format === 'jpeg' ? 'jpg' : format;
    const outputPath = createTempPath(outputExt);

    if (await isGifInput(inputPath, inputExt, mediaContext) && format === 'webp') {
        await runFFmpeg(inputPath, outputPath, cmd => {
            cmd.outputOptions([
                '-an',
                '-loop 0',
                '-c:v libwebp_anim',
                '-quality 80',
                '-compression_level 6',
            ]);
        });
        return outputPath;
    }

    await sharp(inputPath, { animated: false })[format](options).toFile(outputPath);
    return outputPath;
}

async function resize(inputPath, width, height, ext = '', mediaContext = {}) {
    if (await isGifInput(inputPath, ext, mediaContext)) {
        if (width && height) {
            return gifFilter(inputPath, `scale=${width}:${height}:force_original_aspect_ratio=decrease`);
        }
        if (width) {
            return gifFilter(inputPath, `scale=${width}:-1`);
        }
        if (height) {
            return gifFilter(inputPath, `scale=-1:${height}`);
        }
    }
    if (mediaContext?.isVideo) {
        if (width && height) {
            return videoFilter(inputPath, `scale=${width}:${height}:force_original_aspect_ratio=decrease`);
        }
        if (width) {
            return videoFilter(inputPath, `scale=${width}:-2`);
        }
        if (height) {
            return videoFilter(inputPath, `scale=-2:${height}`);
        }
    }

    return writeStaticImage(
        sharp(inputPath, { animated: false })
            .resize(width || null, height || null, { fit: 'inside', withoutEnlargement: true }),
        ext
    );
}

async function rotate(inputPath, degrees, ext = '', mediaContext = {}) {
    if (await isGifInput(inputPath, ext, mediaContext)) {
        const radians = `${degrees}*PI/180`;
        return gifFilter(inputPath, `rotate=${radians}:ow=rotw(${radians}):oh=roth(${radians}):fillcolor=black`);
    }
    if (mediaContext?.isVideo) {
        const radians = `${degrees}*PI/180`;
        return videoFilter(inputPath, `rotate=${radians}:ow=rotw(${radians}):oh=roth(${radians}):fillcolor=black`);
    }

    return writeStaticImage(sharp(inputPath, { animated: false }).rotate(degrees), ext);
}

async function flip(inputPath, ext = '', mediaContext = {}) {
    if (await isGifInput(inputPath, ext, mediaContext)) {
        return gifFilter(inputPath, 'vflip');
    }
    if (mediaContext?.isVideo) {
        return videoFilter(inputPath, 'vflip');
    }

    return writeStaticImage(sharp(inputPath, { animated: false }).flip(), ext);
}

async function flop(inputPath, ext = '', mediaContext = {}) {
    if (await isGifInput(inputPath, ext, mediaContext)) {
        return gifFilter(inputPath, 'hflip');
    }
    if (mediaContext?.isVideo) {
        return videoFilter(inputPath, 'hflip');
    }

    return writeStaticImage(sharp(inputPath, { animated: false }).flop(), ext);
}

async function blur(inputPath, sigma, ext = '', mediaContext = {}) {
    if (await isGifInput(inputPath, ext, mediaContext)) {
        return gifFilter(inputPath, `gblur=sigma=${sigma}`);
    }
    if (mediaContext?.isVideo) {
        return videoFilter(inputPath, `gblur=sigma=${sigma}`);
    }

    return writeStaticImage(sharp(inputPath, { animated: false }).blur(sigma), ext);
}

async function invert(inputPath, ext = '', mediaContext = {}) {
    if (await isGifInput(inputPath, ext, mediaContext)) {
        return gifFilter(inputPath, 'negate');
    }
    if (mediaContext?.isVideo) {
        return videoFilter(inputPath, 'negate');
    }

    return writeStaticImage(sharp(inputPath, { animated: false }).negate({ alpha: false }), ext);
}

async function grayscale(inputPath, ext = '', mediaContext = {}) {
    if (await isGifInput(inputPath, ext, mediaContext)) {
        return gifFilter(inputPath, 'hue=s=0');
    }
    if (mediaContext?.isVideo) {
        return videoFilter(inputPath, 'hue=s=0');
    }

    return writeStaticImage(sharp(inputPath, { animated: false }).grayscale(), ext);
}

async function deepfry(inputPath, ext = '', mediaContext = {}) {
    if (await isGifInput(inputPath, ext, mediaContext)) {
        return gifFilter(inputPath, 'eq=saturation=4:contrast=1.45:brightness=0.04,unsharp=5:5:1.2:5:5:0,noise=alls=12:allf=t+u');
    }
    if (mediaContext?.isVideo) {
        return videoFilter(inputPath, 'eq=saturation=4:contrast=1.45:brightness=0.04,unsharp=5:5:1.2:5:5:0,noise=alls=12:allf=t+u');
    }

    // Heavy saturation + sharpen + low-quality JPEG encoding = deep fried aesthetic
    const friedBuffer = await sharp(inputPath, { animated: false })
        .modulate({ saturation: 4, brightness: 1.1 })
        .sharpen({ sigma: 2, m1: 1, m2: 5 })
        .jpeg({ quality: 1, chromaSubsampling: '4:2:0' })
        .toBuffer();
    return writeStaticImage(sharp(friedBuffer), ext);
}

// Rotate the hue by `degrees` (0-360). Static images via sharp .modulate(); GIF/video
// via the ffmpeg hue filter. (MediaForge: hue=h={h}.)
async function hue(inputPath, degrees, ext = '', mediaContext = {}) {
    if (await isGifInput(inputPath, ext, mediaContext)) {
        return gifFilter(inputPath, `hue=h=${degrees}`);
    }
    if (mediaContext?.isVideo) {
        return videoFilter(inputPath, `hue=h=${degrees}`);
    }
    // sharp modulate hue is in degrees too.
    return writeStaticImage(sharp(inputPath, { animated: false }).modulate({ hue: degrees }), ext);
}

// Tint media toward a single { r, g, b } color: desaturate, then map white -> color.
// (MediaForge: hue=s=0, then lutrgb=r=val*r:g=val*g:b=val*b.)
async function tint(inputPath, rgb, ext = '', mediaContext = {}) {
    const { r, g, b } = rgb;
    if (await isGifInput(inputPath, ext, mediaContext)) {
        const rf = (r / 255).toFixed(4), gf = (g / 255).toFixed(4), bf = (b / 255).toFixed(4);
        return gifFilter(inputPath, `hue=s=0,lutrgb=r=val*${rf}:g=val*${gf}:b=val*${bf}`);
    }
    if (mediaContext?.isVideo) {
        const rf = (r / 255).toFixed(4), gf = (g / 255).toFixed(4), bf = (b / 255).toFixed(4);
        return videoFilter(inputPath, `hue=s=0,lutrgb=r=val*${rf}:g=val*${gf}:b=val*${bf}`);
    }
    // sharp: grayscale then tint to the target colour.
    return writeStaticImage(sharp(inputPath, { animated: false }).grayscale().tint({ r, g, b }), ext);
}

// jpeg: repeatedly re-compress at low quality to simulate "reposted many times".
// strength = number of compression passes, quality = JPEG Q each pass.
async function jpegify(inputPath, strength = 30, quality = 10, ext = '', mediaContext = {}) {
    if (await isGifInput(inputPath, ext, mediaContext)) {
        // Per-frame heavy compression isn't worth a frame-explode here; emulate with a
        // strong qscale on the GIF's frames via ffmpeg mjpeg round-trip is complex, so
        // apply a single aggressive re-encode that reads as the same artifacting.
        return gifFilter(inputPath, `noise=alls=${Math.min(60, strength)}:allf=t,eq=saturation=1.3`);
    }
    if (mediaContext?.isVideo) {
        // crank mpeg quantizer for blocky jpeg-ish artifacts
        const outputPath = createTempPath('mp4');
        const outputOptions = await mp4OutputOptions(inputPath, { qualityMultiplier: 0.3, maxVideoKbps: 700 });
        await runFFmpeg(inputPath, outputPath, cmd => {
            cmd.videoFilters('scale=ceil(iw/2)*2:ceil(ih/2)*2').outputOptions(['-q:v', '31', ...outputOptions]);
        });
        return outputPath;
    }
    // Static image: round-trip through JPEG `strength` times.
    let buf = await sharp(inputPath, { animated: false }).jpeg({ quality }).toBuffer();
    for (let i = 1; i < strength; i++) {
        buf = await sharp(buf).jpeg({ quality }).toBuffer();
    }
    return writeStaticImage(sharp(buf), ext);
}

// Get image dimensions
async function getMetadata(inputPath) {
    return sharp(inputPath).metadata();
}

module.exports = { toFormat, resize, rotate, flip, flop, blur, invert, grayscale, deepfry, hue, tint, jpegify, getMetadata };
