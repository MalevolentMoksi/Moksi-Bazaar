// src/commands/games/tetris.js - Full Discord Tetris Implementation
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Tetris piece definitions with rotations
const PIECES = {
    I: {
        color: 0x00FFFF, // Cyan
        blocks: [
            [[1,1,1,1]],
            [[1],[1],[1],[1]]
        ]
    },
    O: {
        color: 0xFFFF00, // Yellow
        blocks: [
            [[1,1],[1,1]]
        ]
    },
    T: {
        color: 0x800080, // Purple
        blocks: [
            [[0,1,0],[1,1,1]],
            [[1,0],[1,1],[1,0]],
            [[1,1,1],[0,1,0]],
            [[0,1],[1,1],[0,1]]
        ]
    },
    S: {
        color: 0x00FF00, // Green
        blocks: [
            [[0,1,1],[1,1,0]],
            [[1,0],[1,1],[0,1]]
        ]
    },
    Z: {
        color: 0xFF0000, // Red
        blocks: [
            [[1,1,0],[0,1,1]],
            [[0,1],[1,1],[1,0]]
        ]
    },
    J: {
        color: 0x0000FF, // Blue
        blocks: [
            [[1,0,0],[1,1,1]],
            [[1,1],[1,0],[1,0]],
            [[1,1,1],[0,0,1]],
            [[0,1],[0,1],[1,1]]
        ]
    },
    L: {
        color: 0xFFA500, // Orange
        blocks: [
            [[0,0,1],[1,1,1]],
            [[1,0],[1,0],[1,1]],
            [[1,1,1],[1,0,0]],
            [[1,1],[0,1],[0,1]]
        ]
    }
};

// Visual blocks for rendering
const BLOCKS = {
    EMPTY: '⬛',
    FILLED: '🟦',
    ACTIVE: '🟨',
    GHOST: '⬜',
    I: '🟦', // Cyan-ish
    O: '🟨', // Yellow
    T: '🟪', // Purple
    S: '🟩', // Green
    Z: '🟥', // Red
    J: '🟦', // Blue
    L: '🟧'  // Orange
};

// Game state storage
const activeGames = new Map();

class TetrisGame {
    constructor(userId, channelId) {
        this.userId = userId;
        this.channelId = channelId;
        this.board = Array(20).fill().map(() => Array(10).fill(0));
        this.score = 0;
        this.lines = 0;
        this.level = 1;
        this.gameOver = false;
        this.paused = false;
        
        // Current piece
        this.currentPiece = null;
        this.currentX = 0;
        this.currentY = 0;
        this.currentRotation = 0;
        
        // Next piece
        this.nextPiece = null;
        
        // Game timing
        this.fallTimer = null;
        this.fallSpeed = 1000; // 1 second initially
        
        // Initialize first pieces
        this.spawnPiece();
        this.nextPiece = this.getRandomPiece();
    }
    
    getRandomPiece() {
        const pieces = Object.keys(PIECES);
        return pieces[Math.floor(Math.random() * pieces.length)];
    }
    
    spawnPiece() {
        this.currentPiece = this.nextPiece || this.getRandomPiece();
        this.currentX = 3;
        this.currentY = 0;
        this.currentRotation = 0;
        this.nextPiece = this.getRandomPiece();
        
        // Check game over
        if (!this.isValidPosition(this.currentX, this.currentY, this.currentRotation)) {
            this.gameOver = true;
            this.stopFallTimer();
            return false;
        }
        
        return true;
    }
    
    getCurrentPieceBlocks() {
        return PIECES[this.currentPiece].blocks[this.currentRotation];
    }
    
    isValidPosition(x, y, rotation) {
        const blocks = PIECES[this.currentPiece].blocks[rotation];
        
        for (let py = 0; py < blocks.length; py++) {
            for (let px = 0; px < blocks[py].length; px++) {
                if (blocks[py][px]) {
                    const nx = x + px;
                    const ny = y + py;
                    
                    // Check boundaries
                    if (nx < 0 || nx >= 10 || ny >= 20) return false;
                    
                    // Check collision with existing blocks
                    if (ny >= 0 && this.board[ny][nx]) return false;
                }
            }
        }
        return true;
    }
    
    placePiece() {
        const blocks = this.getCurrentPieceBlocks();
        
        for (let py = 0; py < blocks.length; py++) {
            for (let px = 0; px < blocks[py].length; px++) {
                if (blocks[py][px]) {
                    const nx = this.currentX + px;
                    const ny = this.currentY + py;
                    if (ny >= 0) {
                        this.board[ny][nx] = this.currentPiece;
                    }
                }
            }
        }
        
        this.clearLines();
        this.spawnPiece();
    }
    
    clearLines() {
        let linesCleared = 0;
        
        for (let y = 19; y >= 0; y--) {
            if (this.board[y].every(cell => cell !== 0)) {
                // Line is full, remove it
                this.board.splice(y, 1);
                this.board.unshift(Array(10).fill(0));
                linesCleared++;
                y++; // Check same line again
            }
        }
        
        if (linesCleared > 0) {
            this.lines += linesCleared;
            this.score += linesCleared * 100 * this.level;
            this.level = Math.floor(this.lines / 10) + 1;
            this.fallSpeed = Math.max(100, 1000 - (this.level - 1) * 100);
        }
    }
    
    moveLeft() {
        if (this.isValidPosition(this.currentX - 1, this.currentY, this.currentRotation)) {
            this.currentX--;
            return true;
        }
        return false;
    }
    
    moveRight() {
        if (this.isValidPosition(this.currentX + 1, this.currentY, this.currentRotation)) {
            this.currentX++;
            return true;
        }
        return false;
    }
    
    rotate() {
        const newRotation = (this.currentRotation + 1) % PIECES[this.currentPiece].blocks.length;
        if (this.isValidPosition(this.currentX, this.currentY, newRotation)) {
            this.currentRotation = newRotation;
            return true;
        }
        return false;
    }
    
    softDrop() {
        if (this.isValidPosition(this.currentX, this.currentY + 1, this.currentRotation)) {
            this.currentY++;
            this.score++;
            return true;
        } else {
            this.placePiece();
            return false;
        }
    }
    
    hardDrop() {
        let dropDistance = 0;
        while (this.isValidPosition(this.currentX, this.currentY + 1, this.currentRotation)) {
            this.currentY++;
            dropDistance++;
        }
        this.score += dropDistance * 2;
        this.placePiece();
        return dropDistance;
    }
    
    getGhostPosition() {
        let ghostY = this.currentY;
        while (this.isValidPosition(this.currentX, ghostY + 1, this.currentRotation)) {
            ghostY++;
        }
        return ghostY;
    }
    
    renderBoard() {
        // Create a copy of the board for rendering
        const renderBoard = this.board.map(row => [...row]);
        
        // Add ghost piece
        const ghostY = this.getGhostPosition();
        if (ghostY > this.currentY) {
            const blocks = this.getCurrentPieceBlocks();
            for (let py = 0; py < blocks.length; py++) {
                for (let px = 0; px < blocks[py].length; px++) {
                    if (blocks[py][px]) {
                        const nx = this.currentX + px;
                        const ny = ghostY + py;
                        if (ny >= 0 && ny < 20 && nx >= 0 && nx < 10 && renderBoard[ny][nx] === 0) {
                            renderBoard[ny][nx] = 'GHOST';
                        }
                    }
                }
            }
        }
        
        // Add current piece
        const blocks = this.getCurrentPieceBlocks();
        for (let py = 0; py < blocks.length; py++) {
            for (let px = 0; px < blocks[py].length; px++) {
                if (blocks[py][px]) {
                    const nx = this.currentX + px;
                    const ny = this.currentY + py;
                    if (ny >= 0 && ny < 20 && nx >= 0 && nx < 10) {
                        renderBoard[ny][nx] = 'ACTIVE';
                    }
                }
            }
        }
        
        // Convert to visual blocks
        let boardStr = '```\n┌────────────┐\n';
        for (let y = 0; y < 20; y++) {
            boardStr += '│';
            for (let x = 0; x < 10; x++) {
                const cell = renderBoard[y][x];
                if (cell === 'ACTIVE') {
                    boardStr += '██';
                } else if (cell === 'GHOST') {
                    boardStr += '░░';
                } else if (cell === 0) {
                    boardStr += '  ';
                } else {
                    boardStr += '▓▓';
                }
            }
            boardStr += '│\n';
        }
        boardStr += '└────────────┘\n```';
        
        return boardStr;
    }
    
    startFallTimer() {
        this.stopFallTimer();
        this.fallTimer = setInterval(() => {
            if (!this.paused && !this.gameOver) {
                this.softDrop();
            }
        }, this.fallSpeed);
    }
    
    stopFallTimer() {
        if (this.fallTimer) {
            clearInterval(this.fallTimer);
            this.fallTimer = null;
        }
    }
    
    pause() {
        this.paused = !this.paused;
    }
    
    destroy() {
        this.stopFallTimer();
        activeGames.delete(`${this.userId}-${this.channelId}`);
    }
}

function createGameEmbed(game) {
    const embed = new EmbedBuilder()
        .setTitle('🎮 Tetris')
        .setDescription(game.renderBoard())
        .setColor(PIECES[game.currentPiece]?.color || 0x0099FF)
        .addFields(
            { name: '📊 Score', value: game.score.toString(), inline: true },
            { name: '📏 Lines', value: game.lines.toString(), inline: true },
            { name: '⚡ Level', value: game.level.toString(), inline: true },
            { name: '🎯 Next', value: `\`${game.nextPiece}\``, inline: true },
            { name: '⏸️ Status', value: game.paused ? 'Paused' : (game.gameOver ? 'Game Over' : 'Playing'), inline: true },
            { name: '⏱️ Speed', value: `${game.fallSpeed}ms`, inline: true }
        )
        .setFooter({ text: 'Use buttons to control • Auto-saves progress' })
        .setTimestamp();
    
    return embed;
}

function createControlButtons(gameOver = false, paused = false) {
    const row1 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('tetris_left')
                .setLabel('◀️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(gameOver),
            new ButtonBuilder()
                .setCustomId('tetris_right')
                .setLabel('▶️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(gameOver),
            new ButtonBuilder()
                .setCustomId('tetris_rotate')
                .setLabel('🔄')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(gameOver),
            new ButtonBuilder()
                .setCustomId('tetris_soft_drop')
                .setLabel('⬇️')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(gameOver),
            new ButtonBuilder()
                .setCustomId('tetris_hard_drop')
                .setLabel('⚡')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(gameOver)
        );
    
    const row2 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('tetris_pause')
                .setLabel(paused ? '▶️ Resume' : '⏸️ Pause')
                .setStyle(ButtonStyle.Success)
                .setDisabled(gameOver),
            new ButtonBuilder()
                .setCustomId('tetris_restart')
                .setLabel('🔄 New Game')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('tetris_quit')
                .setLabel('❌ Quit')
                .setStyle(ButtonStyle.Danger)
        );
    
    return [row1, row2];
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tetris')
        .setDescription('Play a full game of Tetris in Discord!')
        .addStringOption(option =>
            option.setName('action')
                .setDescription('Game action')
                .addChoices(
                    { name: 'New Game', value: 'new' },
                    { name: 'Resume Game', value: 'resume' },
                    { name: 'View Controls', value: 'help' }
                )
        ),

    async execute(interaction) {
        const userId = interaction.user.id;
        const channelId = interaction.channel.id;
        const gameKey = `${userId}-${channelId}`;
        const action = interaction.options.getString('action') || 'new';

        if (action === 'help') {
            const helpEmbed = new EmbedBuilder()
                .setTitle('🎮 Tetris Controls')
                .setDescription('Master the classic puzzle game!')
                .setColor(0x00FF00)
                .addFields(
                    { name: '◀️ Move Left', value: 'Move piece left', inline: true },
                    { name: '▶️ Move Right', value: 'Move piece right', inline: true },
                    { name: '🔄 Rotate', value: 'Rotate piece clockwise', inline: true },
                    { name: '⬇️ Soft Drop', value: 'Move piece down (+1 point)', inline: true },
                    { name: '⚡ Hard Drop', value: 'Drop piece instantly (+2 per row)', inline: true },
                    { name: '⏸️ Pause', value: 'Pause/Resume game', inline: true },
                    { name: '🎯 Scoring', value: 'Lines: 100×level, Drops: +1/+2 per row', inline: false },
                    { name: '📈 Leveling', value: 'Level up every 10 lines (increases speed)', inline: false }
                )
                .setFooter({ text: 'Good luck! Try to clear lines by filling entire rows.' });

            return interaction.reply({ embeds: [helpEmbed], ephemeral: true });
        }

        let game = activeGames.get(gameKey);

        if (action === 'resume' && !game) {
            return interaction.reply({ content: '❌ No active game found. Start a new game!', ephemeral: true });
        }

        if (action === 'new' || !game) {
            // Clean up old game
            if (game) game.destroy();
            
            // Create new game
            game = new TetrisGame(userId, channelId);
            activeGames.set(gameKey, game);
            game.startFallTimer();
        }

        const embed = createGameEmbed(game);
        const buttons = createControlButtons(game.gameOver, game.paused);

        await interaction.reply({
            embeds: [embed],
            components: buttons
        });

        // Handle button interactions
        const collector = interaction.channel.createMessageComponentCollector({
            filter: i => i.user.id === userId && i.customId.startsWith('tetris_'),
            time: 300000 // 5 minutes
        });

        collector.on('collect', async (buttonInteraction) => {
            if (!game || game.gameOver) return;

            let updated = false;
            const action = buttonInteraction.customId.split('_')[1];

            switch (action) {
                case 'left':
                    updated = game.moveLeft();
                    break;
                case 'right':
                    updated = game.moveRight();
                    break;
                case 'rotate':
                    updated = game.rotate();
                    break;
                case 'soft':
                    updated = game.softDrop();
                    break;
                case 'hard':
                    game.hardDrop();
                    updated = true;
                    break;
                case 'pause':
                    game.pause();
                    updated = true;
                    break;
                case 'restart':
                    game.destroy();
                    game = new TetrisGame(userId, channelId);
                    activeGames.set(gameKey, game);
                    game.startFallTimer();
                    updated = true;
                    break;
                case 'quit':
                    game.destroy();
                    collector.stop();
                    return buttonInteraction.update({
                        embeds: [new EmbedBuilder()
                            .setTitle('🎮 Tetris - Game Ended')
                            .setDescription('Thanks for playing!')
                            .setColor(0xFF0000)
                            .addFields(
                                { name: 'Final Score', value: game.score.toString(), inline: true },
                                { name: 'Lines Cleared', value: game.lines.toString(), inline: true },
                                { name: 'Level Reached', value: game.level.toString(), inline: true }
                            )
                        ],
                        components: []
                    });
            }

            if (updated) {
                const newEmbed = createGameEmbed(game);
                const newButtons = createControlButtons(game.gameOver, game.paused);
                
                await buttonInteraction.update({
                    embeds: [newEmbed],
                    components: newButtons
                });
            } else {
                await buttonInteraction.deferUpdate();
            }
        });

        collector.on('end', () => {
            if (game && !game.gameOver) {
                game.destroy();
            }
        });
    },
};