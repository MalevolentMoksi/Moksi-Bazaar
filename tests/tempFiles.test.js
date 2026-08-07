// tests/tempFiles.test.js
//
// downloadToTemp used to trust whatever the caller had checked beforehand: no
// cap on the wire, no deadline on the socket, and a timeout upstream merely
// stopped WAITING while the download carried on filling the disk. These run
// the real code against a real local HTTP server, because a size cap that
// only exists in a mock proves nothing.

const http = require('http');
const fs = require('fs');
const { downloadToTemp } = require('../src/utils/media/tempFiles');

function startServer(handler) {
    return new Promise(resolve => {
        const sockets = new Set();
        const server = http.createServer(handler);
        server.on('connection', (socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
        });
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}/media.mp4`,
                close: () => new Promise(done => {
                    for (const socket of sockets) socket.destroy();
                    server.close(() => done());
                }),
            });
        });
    });
}

describe('the size cap is enforced on the wire', () => {
    test('a Content-Length over the cap is refused before the body streams', async () => {
        const srv = await startServer((req, res) => {
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Length': String(50 * 1024 * 1024),
            });
            res.write(Buffer.alloc(1024));
        });
        try {
            await expect(
                downloadToTemp(srv.url, 'mp4', { maxBytes: 1024 * 1024 })
            ).rejects.toThrow(/over the/);
        } finally {
            await srv.close();
        }
    });

    test('a server that omits Content-Length is cut off mid-stream at the cap', async () => {
        const srv = await startServer((req, res) => {
            // Chunked transfer: no Content-Length to check up front, just an
            // endless stream that only the byte counter can stop.
            res.writeHead(200, { 'Content-Type': 'video/mp4' });
            const chunk = Buffer.alloc(64 * 1024);
            const timer = setInterval(() => { res.write(chunk); }, 2);
            res.on('close', () => clearInterval(timer));
        });
        try {
            await expect(
                downloadToTemp(srv.url, 'mp4', { maxBytes: 256 * 1024 })
            ).rejects.toThrow(/mid-download/);
        } finally {
            await srv.close();
        }
    });
});

describe('the deadline actually aborts', () => {
    test('a dripping server hits the deadline instead of holding the socket forever', async () => {
        const srv = await startServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'video/mp4' });
            res.write(Buffer.alloc(10));
            // ...and then silence, forever.
        });
        try {
            await expect(
                downloadToTemp(srv.url, 'mp4', { timeoutMs: 300 })
            ).rejects.toThrow(/timed out/);
        } finally {
            await srv.close();
        }
    });
});

describe('honest downloads are untouched', () => {
    test('a body under the cap lands byte for byte', async () => {
        const body = Buffer.alloc(10 * 1024, 7);
        const srv = await startServer((req, res) => {
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Length': String(body.length),
            });
            res.end(body);
        });
        try {
            const dest = await downloadToTemp(srv.url, 'mp4', {
                maxBytes: 1024 * 1024,
                timeoutMs: 5000,
            });
            const got = fs.readFileSync(dest);
            expect(got.equals(body)).toBe(true);
            fs.unlinkSync(dest);
        } finally {
            await srv.close();
        }
    });

    test('redirects still work with a cap and a deadline in place', async () => {
        const body = Buffer.from('ok-media');
        const srv = await startServer((req, res) => {
            if (req.url === '/media.mp4') {
                res.writeHead(302, { Location: '/real.mp4' });
                res.end();
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Length': String(body.length),
            });
            res.end(body);
        });
        try {
            const dest = await downloadToTemp(srv.url, 'mp4', {
                maxBytes: 1024 * 1024,
                timeoutMs: 5000,
            });
            expect(fs.readFileSync(dest).equals(body)).toBe(true);
            fs.unlinkSync(dest);
        } finally {
            await srv.close();
        }
    });

    test('the old two-argument call keeps working for every other caller', async () => {
        const body = Buffer.from('legacy');
        const srv = await startServer((req, res) => {
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Length': String(body.length),
            });
            res.end(body);
        });
        try {
            const dest = await downloadToTemp(srv.url, 'mp4');
            expect(fs.readFileSync(dest).equals(body)).toBe(true);
            fs.unlinkSync(dest);
        } finally {
            await srv.close();
        }
    });
});
