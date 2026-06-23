const express = require('express');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// ==================== CONFIGURATION ====================
const API_URL = 'https://aramedia.me/worldcup/api.php';
const WEB_URL = 'https://aramedia.me/worldcup';
const BOT_NUMBER = '919108949369';

// ==================== GLOBAL VARIABLES ====================
let sock;
let currentQR = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// ==================== HELPER FUNCTIONS ====================
function getUserId(jid) {
    return jid.replace(/@[a-z.]+/g, '');
}

async function fetchProfilePicture(sock, jid) {
    const pureNumber = jid.replace(/@[a-z.]+/g, '');
    const correctJid = `${pureNumber}@s.whatsapp.net`;
    try {
        const ppUrl = await sock.profilePictureUrl(correctJid, 'preview');
        return ppUrl || '';
    } catch (error) {
        return '';
    }
}

// ==================== API FUNCTIONS ====================
async function apiRequest(endpoint, method = 'GET', data = null) {
    try {
        const config = {
            method: method,
            url: `${API_URL}?action=${endpoint}`,
            headers: {
                'User-Agent': 'WhatsAppBot/1.0',
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            timeout: 10000
        };
        if (method === 'POST' && data) config.data = data;
        const response = await axios(config);
        return response.data;
    } catch (error) {
        console.error(`API Error (${endpoint}):`, error.message);
        return null;
    }
}

async function createMatchOnServer(matchData) { return await apiRequest('create_match', 'POST', matchData); }
async function getMatchFromServer(matchId) { return await apiRequest(`get_match&match_id=${matchId}`); }
async function getLeaderboardFromServer() { return await apiRequest('get_leaderboard'); }
async function getMatchVotesFromServer(matchId) { return await apiRequest(`get_votes&match_id=${matchId}`); }
async function declareResultOnServer(matchId, winner, score) { return await apiRequest('declare_result', 'POST', { match_id: matchId, winner, score }); }
async function closeMatchOnServer(matchId) { return await apiRequest('close_match', 'POST', { match_id: matchId }); }
async function getActiveMatchFromServer() { return await apiRequest('get_active_match'); }
async function getUserStatsFromServer(waNumber) { return await apiRequest(`get_user_stats&wa_number=${waNumber}`); }
async function getMatchesFromServer() { return await apiRequest('get_matches'); }
async function registerUserOnServer(waNumber, name = '', profilePic = '') {
    console.log(`📝 Registering: ${waNumber}, Name: ${name}, Has Pic: ${profilePic ? '✅' : '❌'}`);
    return await apiRequest('register_user', 'POST', { wa_number: waNumber, name: name, profile_pic: profilePic });
}

// ==================== EXPRESS ROUTES ====================
app.use(express.json());
app.use(express.static('public'));

app.get('/ping', (req, res) => res.status(200).send('OK'));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/debug', (req, res) => {
    res.json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        bot: sock ? 'connected' : 'disconnected'
    });
});

app.get('/', (req, res) => {
    const clickToChatLink = `https://wa.me/${BOT_NUMBER}?text=!vote`;
    res.send(`
        <h1>✅ WhatsApp Bot is Running!</h1>
        <p><a href="/qr" target="_blank"><b>👉 Click Here to Scan QR Code</b></a></p>
        <hr>
        <h3>📱 Click-to-Chat Link:</h3>
        <p><a href="${clickToChatLink}" target="_blank">${clickToChatLink}</a></p>
        <hr>
        <p><a href="${WEB_URL}" target="_blank"><b>📊 View Dashboard</b></a></p>
        <p>Bot Number: ${BOT_NUMBER}</p>
    `);
});

app.get('/qr', async (req, res) => {
    if (currentQR) {
        try {
            const qrImage = await QRCode.toDataURL(currentQR);
            res.send(`
                <h2>Scan this QR Code with WhatsApp</h2>
                <img src="${qrImage}" width="300" height="300" />
                <p><small>Refresh if expired.</small></p>
            `);
        } catch (e) {
            res.send('<h2>Error generating QR. Please refresh.</h2>');
        }
    } else {
        res.send('<h2>Waiting for QR Code... Refresh after 5-10 seconds.</h2>');
    }
});

// ==================== KEEP ALIVE ====================
async function keepAlive() {
    const urls = [
        `http://localhost:${PORT}/ping`,
        `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'whatsapp-bot-v0ts.onrender.com'}/ping`
    ];
    for (const url of urls) {
        try {
            await axios.get(url, { timeout: 8000 });
            console.log(`✅ Keep-alive OK → ${url}`);
            return;
        } catch (err) {
            console.log(`⚠️ Keep-alive failed: ${url}`);
        }
    }
}
setInterval(keepAlive, 4 * 60 * 1000);
setTimeout(keepAlive, 15000);

// ==================== AUTO RESTART LOGIC / CONNECTION ====================
async function connectToWhatsApp() {
    console.log('🔄 Connecting to WhatsApp...');
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            markOnlineOnConnect: true,
            syncFullHistory: false,
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                currentQR = qr;
                console.log('📱 New QR Code Generated');
            }
            if (connection === 'open') {
                console.log('✅ Bot is Online!');
                currentQR = null;
                reconnectAttempts = 0;
                console.log('🤖 Connected to PHP server at:', API_URL);
                scheduleDailyReminder();
            }
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`❌ Connection closed. Status: ${statusCode}`);
                if (statusCode !== DisconnectReason.loggedOut) {
                    reconnectAttempts++;
                    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                        const delay = Math.min(5000 * reconnectAttempts, 30000);
                        console.log(`🔄 Reconnecting in ${delay/1000}s (Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
                        setTimeout(connectToWhatsApp, delay);
                    } else {
                        console.log('🚨 Too many failures. Restarting service...');
                        setTimeout(() => process.exit(1), 3000);
                    }
                } else {
                    console.log('❌ Logged out. Need to scan QR again.');
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('messages.upsert', async (m) => await handleCommands(sock, m));
    } catch (error) {
        console.error('❌ Connect Error:', error);
        reconnectAttempts++;
        if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            setTimeout(connectToWhatsApp, 10000);
        }
    }
}

// ==================== GROUP MANAGEMENT ====================
async function getGroupIds() {
    try {
        if (fs.existsSync('groups.json')) {
            const data = fs.readFileSync('groups.json', 'utf8');
            const groups = JSON.parse(data);
            return groups.filter(g => g.active).map(g => g.id);
        }
    } catch (error) {
        console.error('Error reading groups file:', error);
    }
    return [];
}

async function saveGroup(groupId) {
    try {
        let groups = [];
        if (fs.existsSync('groups.json')) {
            const data = fs.readFileSync('groups.json', 'utf8');
            groups = JSON.parse(data);
        }
        const exists = groups.some(g => g.id === groupId);
        if (!exists) {
            groups.push({ id: groupId, active: true, joined_at: new Date().toISOString() });
            fs.writeFileSync('groups.json', JSON.stringify(groups, null, 2));
            console.log(`📝 Group saved: ${groupId}`);
        }
    } catch (error) {
        console.error('Error saving group:', error);
    }
}

// ==================== DAILY REMINDER ====================
async function sendDailyReminder() {
    try {
        console.log('⏰ Sending daily reminder...');
        const groupIds = await getGroupIds();
        if (groupIds.length === 0) return;
        const clickToChatLink = `https://wa.me/${BOT_NUMBER}?text=!vote`;
        const message = `🌅 *Good Morning!* 🌅\n\n⚽ *World Cup Predictions*\n\nType *!vote* to get your personal voting link!\nOr click: ${clickToChatLink}\n\n📊 Standings: ${WEB_URL}/leaderboard.php\nGood luck! 🍀`;
        for (const groupId of groupIds) {
            try {
                await sock.sendMessage(groupId, { text: message });
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {}
        }
    } catch (error) {
        console.error('Error sending daily reminder:', error);
    }
}

function scheduleDailyReminder() {
    const now = new Date();
    const uaeTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
    const targetTime = new Date(uaeTime);
    targetTime.setHours(9, 0, 0, 0);
    if (uaeTime > targetTime) targetTime.setDate(targetTime.getDate() + 1);
    const msUntilTarget = targetTime.getTime() - uaeTime.getTime();
    console.log(`⏰ Next daily reminder scheduled for UAE Time: ${targetTime.toLocaleString('en-US', { timeZone: 'Asia/Dubai' })}`);
    setTimeout(() => {
        sendDailyReminder();
        setInterval(sendDailyReminder, 24 * 60 * 60 * 1000);
    }, msUntilTarget);
}

// ==================== COMMAND HANDLERS ====================
async function handleCommands(sock, msg) {
    const msgData = msg.messages[0];
    if (!msgData.key.fromMe && msgData.message?.conversation) {
        const text = msgData.message.conversation.trim();
        const from = msgData.key.remoteJid;
        const sender = msgData.key.participant || msgData.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        if (isGroup) await saveGroup(from);
        
        const pushName = msgData.pushName || '';
        const waNumber = getUserId(sender);
        const displayName = pushName || waNumber;
        
        console.log(`📩 Received: "${text}" from ${displayName}`);
        let profilePic = await fetchProfilePicture(sock, sender);
        await registerUserOnServer(waNumber, displayName, profilePic);
        
        const parts = text.split(' ');
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);
        
        if (command === '!vote') return await handleVoteCommand(sock, from, sender, isGroup, waNumber, displayName);
        if (isGroup && command === '!creatematch') return await handleCreateMatchCommand(sock, from, text);
        if (command === '!leaderboard' || command === '!standings') return await handleLeaderboardCommand(sock, from, waNumber);
        if (command === '!matches') return await handleMatchesCommand(sock, from, waNumber);
        if (command === '!matchstatus' || command === '!votes') return await handleMatchStatusCommand(sock, from, waNumber);
        if (command === '!stats') return await handleStatsCommand(sock, from, waNumber);
        if (isGroup && command === '!closematch') return await handleCloseMatchCommand(sock, from, args);
        if (isGroup && command === '!declareresult') return await handleDeclareResultCommand(sock, from, text, args);
        if (command === '!help' || command === '!menu') return await handleHelpCommand(sock, from);
    }
}

// ==================== INDIVIDUAL COMMAND ACTIONS ====================
async function handleVoteCommand(sock, from, sender, isGroup, waNumber, displayName) {
    const votingLink = `${WEB_URL}/index.php?wa=${waNumber}`;
    try {
        const match = await getActiveMatchFromServer();
        let messageText = '';
        if (match) {
            const fullLink = `${WEB_URL}/index.php?match=${match.id}&wa=${waNumber}`;
            messageText = `📱 *Your Personal Voting Link*\n\nClick the link below to vote:\n${fullLink}\n\n👤 Name: ${displayName}\n🆔 ID: ${waNumber}\n⚽ Match: ${match.name}\n⏰ Kickoff: ${new Date(match.kickoff).toLocaleString()}\n\n🔒 This link is personal to you.`;
        } else {
            messageText = `📱 *Your Personal Voting Link*\n\nClick the link below to vote:\n${votingLink}\n\n👤 Name: ${displayName}\n🆔 ID: ${waNumber}\nNo active match found.`;
        }
        await sock.sendMessage(sender, { text: messageText });
        if (isGroup) await sock.sendMessage(from, { text: `✅ I've sent your personal voting link via private message. Check your DMs! 📩` });
    } catch (error) {
        console.error('Error in vote command:', error);
    }
}

async function handleCreateMatchCommand(sock, from, text) {
    try {
        let matchName = '', kickoffTime = '', team1 = '', team2 = '';
        const matchNameMatch = text.match(/"([^"]+)"/);
        if (matchNameMatch) {
            matchName = matchNameMatch[1];
            const teams = matchName.split(' vs ').map(t => t.trim());
            team1 = teams[0] || ''; team2 = teams[1] || '';
        }
        const timeMatch = text.match(/"([^"]+)"$/);
        if (timeMatch) kickoffTime = timeMatch[1];

        if (!matchName || !kickoffTime || !team1 || !team2) {
            return await sock.sendMessage(from, { text: '❌ Usage: !creatematch "Team A vs Team B" "2026-06-20 15:00"' });
        }

        const matchData = { id: Date.now().toString(), name: matchName, team1, team2, kickoff: new Date(kickoffTime).toISOString(), created_by: from };
        const result = await createMatchOnServer(matchData);

        if (result && result.success) {
            await sock.sendMessage(from, { text: `✅ Match Created Successfully!\n\n📋 *${matchName}*\n⏰ Kickoff: ${new Date(kickoffTime).toLocaleString()}\n\n📱 Type !vote to get your custom link!` });
        } else {
            await sock.sendMessage(from, { text: '❌ Failed to create match.' });
        }
    } catch (error) {
        await sock.sendMessage(from, { text: '❌ Error creating match. Check format!' });
    }
}

async function handleLeaderboardCommand(sock, from, waNumber) {
    try {
        const data = await getLeaderboardFromServer();
        if (!data || data.length === 0) return await sock.sendMessage(from, { text: `📊 No points recorded yet!\n\nStart voting by typing: !vote` });

        let response = '🏆 *Leaderboard*\n\n';
        data.forEach((user, index) => {
            const name = user.name || user.wa_number || 'Anonymous';
            const isYou = user.wa_number === waNumber ? ' 👈' : '';
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            response += `${medal} ${name}: ${user.total_points || 0} pts${isYou}\n   📊 ${user.correct_predictions || 0}/${user.total_predictions || 0} correct\n`;
        });
        response += `\n📱 Full leaderboard: ${WEB_URL}/leaderboard.php`;
        await sock.sendMessage(from, { text: response });
    } catch (error) {
        console.error(error);
    }
}

async function handleMatchesCommand(sock, from, waNumber) {
    try {
        const matches = await getMatchesFromServer();
        if (!matches || matches.length === 0) return await sock.sendMessage(from, { text: '📋 No matches available!' });

        let responseText = '📋 *Matches*\n\n';
        const upcoming = matches.filter(m => m.status === 'active' && new Date(m.kickoff) > new Date());
        if (upcoming.length > 0) {
            responseText += '🟢 *Upcoming Matches (Voting Open)*\n';
            upcoming.forEach(m => { responseText += `📌 *${m.name}*\n   ⏰ ${new Date(m.kickoff).toLocaleString()}\n\n`; });
        }
        const completed = matches.filter(m => m.status === 'completed');
        if (completed.length > 0) {
            responseText += '🔵 *Completed Matches*\n';
            completed.slice(-3).forEach(m => { responseText += `📌 ${m.name}\n   🏅 Winner: ${m.winner || 'Unknown'} (${m.score || 'N/A'})\n\n`; });
        }
        responseText += `\n📱 Get your link: !vote`;
        await sock.sendMessage(from, { text: responseText });
    } catch (error) {
        console.error(error);
    }
}

async function handleMatchStatusCommand(sock, from, waNumber) {
    try {
        const match = await getActiveMatchFromServer();
        if (!match) return await sock.sendMessage(from, { text: `❌ No active match!` });

        const votes = await getMatchVotesFromServer(match.id);
        let responseText = `📊 *Voting Status*\n\n📋 ${match.name}\n\n`;
        const t1Count = votes?.filter(v => v.team_voted === match.team1).length || 0;
        const t2Count = votes?.filter(v => v.team_voted === match.team2).length || 0;
        const total = t1Count + t2Count;

        const bar1 = '█'.repeat(Math.min(Math.floor(t1Count / (total || 1) * 15), 15));
        const bar2 = '█'.repeat(Math.min(Math.floor(t2Count / (total || 1) * 15), 15));

        responseText += `🏆 ${match.team1}\n${bar1 || ' '} ${t1Count} votes\n\n🏆 ${match.team2}\n${bar2 || ' '} ${t2Count} votes\n\n📊 Total: ${total}`;
        await sock.sendMessage(from, { text: responseText });
    } catch (error) {
        console.error(error);
    }
}

async function handleStatsCommand(sock, from, waNumber) {
    try {
        const user = await getUserStatsFromServer(waNumber);
        if (!user) return await sock.sendMessage(from, { text: `📊 No stats found. Get voting via !vote` });

        let responseText = `📊 *Your Stats*\n\n👤 Name: ${user.name || 'Not set'}\n⭐ Points: ${user.total_points || 0}\n✅ Correct: ${user.correct_predictions || 0}/${user.total_predictions || 0}`;
        await sock.sendMessage(from, { text: responseText });
    } catch (error) {
        console.error(error);
    }
}

async function handleCloseMatchCommand(sock, from, args) {
    const matchId = args[0];
    if (!matchId) return await sock.sendMessage(from, { text: '❌ Usage: !closematch [match_id]' });
    try {
        const result = await closeMatchOnServer(matchId);
        if (result && result.success) await sock.sendMessage(from, { text: `🔒 Voting locked for Match ID: ${matchId}` });
    } catch (error) {
        console.error(error);
    }
}

async function handleDeclareResultCommand(sock, from, text, args) {
    try {
        const matchId = args[0];
        const teamName = args.slice(1, args.length - 1).join(' ').replace(/^"|"$/g, '');
        const score = args[args.length - 1];
        if (!matchId || !teamName || !score) return await sock.sendMessage(from, { text: '❌ Usage: !declareresult [match_id] "Team Name" score' });

        const result = await declareResultOnServer(matchId, teamName, score);
        if (result && result.success) {
            let resp = `🏆 *Result Settled!*\n🏅 Winner: ${teamName} (${score})\n`;
            await sock.sendMessage(from, { text: resp });
        }
    } catch (error) {
        console.error(error);
    }
}

async function handleHelpCommand(sock, from) {
    let response = '📋 *Available Commands*\n\n👤 *User*\n!vote, !matches, !leaderboard, !stats, !matchstatus\n\n👑 *Admin*\n!creatematch, !closematch, !declareresult';
    await sock.sendMessage(from, { text: response });
}

// ==================== START SERVER & BOT ====================
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    connectToWhatsApp();
});