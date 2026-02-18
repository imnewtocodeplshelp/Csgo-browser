const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const os = require('os');

// Configuration
const PORT = process.env.PORT || 3000;
const MAX_POSITION_CHANGE = 5;
const BULLET_SPEED = 1.5;
const BULLET_LIFETIME = 200; // frames (~3.3 seconds at 60fps)
const BULLET_DAMAGE = 20;
const MAX_HEALTH = 100;
const RESPAWN_TIME = 3000; // 3 seconds

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

app.use(express.static(__dirname));

// Game state
let players = {};
let bullets = [];
let bulletIdCounter = 0;

// Validation
function isValidPosition(oldPos, newPos) {
    if (!oldPos) return true;
    const dx = Math.abs(newPos.x - oldPos.x);
    const dy = Math.abs(newPos.y - oldPos.y);
    const dz = Math.abs(newPos.z - oldPos.z);
    return dx < MAX_POSITION_CHANGE && dy < MAX_POSITION_CHANGE && dz < MAX_POSITION_CHANGE;
}

// Calculate distance between two points
function distance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dz = p1.z - p2.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Check if bullet hits player
function checkBulletHit(bullet, playerId, playerPos) {
    const hitRadius = 0.6; // Player collision radius
    const dist = distance(bullet.pos, playerPos);
    return dist < hitRadius;
}

io.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] 🎮 Player connected: ${socket.id}`);
    console.log(`   Total players: ${Object.keys(players).length + 1}`);
    
    // Initialize player
    players[socket.id] = { 
        x: 0, 
        y: 1.7, 
        z: 0, 
        ry: 0,
        health: MAX_HEALTH,
        alive: true,
        kills: 0,
        deaths: 0,
        lastUpdate: Date.now()
    };
    
    // Send current game state to new player
    socket.emit('init', {
        id: socket.id,
        players: players,
        bullets: bullets
    });
    
    // Broadcast new player to others
    socket.broadcast.emit('newPlayer', { 
        id: socket.id, 
        ...players[socket.id]
    });

    // Handle player movement
    socket.on('playerMovement', (data) => {
        if (players[socket.id] && players[socket.id].alive) {
            // Validate position
            if (!isValidPosition(players[socket.id], data)) {
                console.warn(`⚠️  [ANTI-CHEAT] Suspicious movement from ${socket.id}`);
                socket.emit('forcePosition', players[socket.id]);
                return;
            }
            
            // Update player data
            Object.assign(players[socket.id], {
                x: data.x,
                y: data.y,
                z: data.z,
                ry: data.ry,
                lastUpdate: Date.now()
            });
            
            // Broadcast to other players
            socket.broadcast.emit('playerMoved', { 
                id: socket.id, 
                ...players[socket.id] 
            });
        }
    });

    // Handle bullet firing (SERVER AUTHORITATIVE)
    socket.on('fireBullet', (data) => {
        if (!players[socket.id] || !players[socket.id].alive) return;
        
        if (!data.pos || !data.dir) {
            console.warn(`⚠️  Invalid bullet data from ${socket.id}`);
            return;
        }

        // Create bullet on server
        const bullet = {
            id: bulletIdCounter++,
            ownerId: socket.id,
            pos: { ...data.pos },
            vel: {
                x: data.dir.x * BULLET_SPEED,
                y: data.dir.y * BULLET_SPEED,
                z: data.dir.z * BULLET_SPEED
            },
            life: BULLET_LIFETIME
        };
        
        bullets.push(bullet);
        
        // Broadcast bullet to all clients
        io.emit('spawnBullet', bullet);
        
        console.log(`💥 ${socket.id} fired bullet #${bullet.id}`);
    });

    // Handle player hit by bullet (client reports, server validates)
    socket.on('playerHit', (data) => {
        const { bulletId, targetId } = data;
        
        // Validate the hit on server
        if (players[targetId] && players[targetId].alive) {
            const bullet = bullets.find(b => b.id === bulletId);
            if (bullet && bullet.ownerId !== targetId) {
                // Apply damage
                players[targetId].health -= BULLET_DAMAGE;
                
                console.log(`🎯 Bullet #${bulletId} hit ${targetId} (${players[targetId].health} HP remaining)`);
                
                // Broadcast health update
                io.emit('healthUpdate', {
                    id: targetId,
                    health: players[targetId].health
                });
                
                // Check if player died
                if (players[targetId].health <= 0) {
                    players[targetId].alive = false;
                    players[targetId].deaths++;
                    
                    if (players[bullet.ownerId]) {
                        players[bullet.ownerId].kills++;
                    }
                    
                    console.log(`💀 ${targetId} was killed by ${bullet.ownerId}`);
                    
                    io.emit('playerDied', {
                        id: targetId,
                        killerId: bullet.ownerId
                    });
                    
                    // Respawn after delay
                    setTimeout(() => {
                        if (players[targetId]) {
                            players[targetId].health = MAX_HEALTH;
                            players[targetId].alive = true;
                            players[targetId].x = Math.random() * 20 - 10;
                            players[targetId].y = 20;
                            players[targetId].z = Math.random() * 20 - 10;
                            
                            console.log(`♻️  ${targetId} respawned`);
                            
                            io.emit('playerRespawn', {
                                id: targetId,
                                ...players[targetId]
                            });
                        }
                    }, RESPAWN_TIME);
                }
                
                // Remove bullet
                bullets = bullets.filter(b => b.id !== bulletId);
                io.emit('removeBullet', bulletId);
            }
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`[${new Date().toISOString()}] 👋 Player disconnected: ${socket.id}`);
        
        // Remove player's bullets
        bullets = bullets.filter(b => b.ownerId !== socket.id);
        
        delete players[socket.id];
        console.log(`   Remaining players: ${Object.keys(players).length}`);
        io.emit('playerDisconnected', socket.id);
    });
    
    socket.on('error', (error) => {
        console.error(`❌ Socket error for ${socket.id}:`, error);
    });
});

// Game loop - Update bullets on server
setInterval(() => {
    if (bullets.length === 0) return;
    
    // Update bullet positions
    for (let i = bullets.length - 1; i >= 0; i--) {
        const bullet = bullets[i];
        
        // Move bullet
        bullet.pos.x += bullet.vel.x;
        bullet.pos.y += bullet.vel.y;
        bullet.pos.z += bullet.vel.z;
        
        bullet.life--;
        
        // Remove expired bullets
        if (bullet.life <= 0) {
            bullets.splice(i, 1);
            io.emit('removeBullet', bullet.id);
            continue;
        }
        
        // Check collision with players (server-side hit detection)
        for (const playerId in players) {
            const player = players[playerId];
            
            // Skip dead players and bullet owner
            if (!player.alive || playerId === bullet.ownerId) continue;
            
            // Check if bullet hits this player
            if (checkBulletHit(bullet, playerId, player)) {
                // Apply damage
                player.health -= BULLET_DAMAGE;
                
                console.log(`🎯 Server detected: Bullet #${bullet.id} hit ${playerId} (${player.health} HP)`);
                
                // Broadcast health update
                io.emit('healthUpdate', {
                    id: playerId,
                    health: player.health
                });
                
                // Check if player died
                if (player.health <= 0) {
                    player.alive = false;
                    player.deaths++;
                    
                    if (players[bullet.ownerId]) {
                        players[bullet.ownerId].kills++;
                    }
                    
                    console.log(`💀 ${playerId} was killed by ${bullet.ownerId}`);
                    
                    io.emit('playerDied', {
                        id: playerId,
                        killerId: bullet.ownerId,
                        killerKills: players[bullet.ownerId]?.kills || 0
                    });
                    
                    // Respawn after delay
                    setTimeout(() => {
                        if (players[playerId]) {
                            player.health = MAX_HEALTH;
                            player.alive = true;
                            player.x = Math.random() * 20 - 10;
                            player.y = 20;
                            player.z = Math.random() * 20 - 10;
                            
                            console.log(`♻️  ${playerId} respawned`);
                            
                            io.emit('playerRespawn', {
                                id: playerId,
                                ...player
                            });
                        }
                    }, RESPAWN_TIME);
                }
                
                // Remove bullet
                bullets.splice(i, 1);
                io.emit('removeBullet', bullet.id);
                break; // Bullet can only hit one player
            }
        }
    }
    
    // Broadcast bullet positions (for smooth interpolation on client)
    if (bullets.length > 0) {
        io.emit('bulletsUpdate', bullets.map(b => ({
            id: b.id,
            pos: b.pos
        })));
    }
    
}, 1000 / 60); // 60 FPS server tick

// Clean up inactive players
setInterval(() => {
    const now = Date.now();
    const timeout = 60000;
    
    Object.keys(players).forEach(id => {
        if (now - players[id].lastUpdate > timeout) {
            console.log(`🧹 Removing inactive player: ${id}`);
            bullets = bullets.filter(b => b.ownerId !== id);
            delete players[id];
            io.emit('playerDisconnected', id);
        }
    });
}, 30000);

// Start server
http.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log('\n' + '='.repeat(70));
    console.log('🎮 FPS GAME SERVER - WITH HEALTH SYSTEM & SERVER-SIDE BULLETS');
    console.log('='.repeat(70));
    console.log(`📍 Local:    http://localhost:${PORT}`);
    console.log(`📍 Network:  http://${localIP}:${PORT}`);
    console.log('='.repeat(70));
    console.log('✅ Features: Health System, Server Authority, Anti-Cheat');
    console.log('='.repeat(70) + '\n');
    console.log('Waiting for players to connect...\n');
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
