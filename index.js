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

// ==================== HELPER FUNCTIONS ====================
function getUserId(jid) {
    // Extract the ID from JID (remove @suffix)
    let id = jid.replace(/@[a-z.]+/g, '');
    return id;
}

// Your code is already doing exactly what it should
async function fetchProfilePicture(sock, jid) {
    const pureNumber = jid.replace(/@[a-z.]+/g, '');
    const correctJid = `${pureNumber}@s.whatsapp.net`;
    
    console.log(`📸 Fetching profile picture for: ${correctJid}`);
    
    try {
        const ppUrl = await sock.profilePictureUrl(correctJid, 'preview');
        if (ppUrl) {
            console.log(`✅ Profile picture found`);
            return ppUrl;
        }
    } catch (error) {
        console.log(`📸 No profile picture: ${error.message}`);
    }
    
    return '';
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
        
        if (method === 'POST' && data) {
            config.data = data;
        }
        
        const response = await axios(config);
        return response.data;
    } catch (error) {
        console.error(`API Error (${endpoint}):`, error.message);
        return null;
    }
}

async function createMatchOnServer(matchData) {
    return await apiRequest('create_match', 'POST', matchData);
}

async function getMatchFromServer(matchId) {
    return await apiRequest(`get_match&match_id=${matchId}`);
}

async function getLeaderboardFromServer() {
    return await apiRequest('get_leaderboard');
}

async function getMatchVotesFromServer(matchId) {
    return await apiRequest(`get_votes&match_id=${matchId}`);
}

async function declareResultOnServer(matchId, winner, score) {
    return await apiRequest('declare_result', 'POST', { match_id: matchId, winner, score });
}

async function closeMatchOnServer(matchId) {
    return await apiRequest('close_match', 'POST', { match_id: matchId });
}

async function getActiveMatchFromServer() {
    return await apiRequest('get_active_match');
}

async function getUserStatsFromServer(waNumber) {
    return await apiRequest(`get_user_stats&wa_number=${waNumber}`);
}

async function getMatchesFromServer() {
    return await apiRequest('get_matches');
}

async function registerUserOnServer(waNumber, name = '', profilePic = '') {
    console.log(`📝 Registering: ${waNumber}, Name: ${name}, Has Pic: ${profilePic ? '✅' : '❌'}`);
    return await apiRequest('register_user', 'POST', {
        wa_number: waNumber,
        name: name,
        profile_pic: profilePic
    });
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
        
        if (groupIds.length === 0) {
            console.log('No groups to send reminder to.');
            return;
        }
        
        const clickToChatLink = `https://wa.me/${BOT_NUMBER}?text=!vote`;
        
        const message = `🌅 *Good Morning!* 🌅\n\n` +
                       `⚽ *World Cup Predictions*\n\n` +
                       `Type *!vote* to get your personal voting link!\n` +
                       `Or click this link to vote:\n` +
                       `${clickToChatLink}\n\n` +
                       `📊 Check standings: ${WEB_URL}/leaderboard.php\n` +
                       `📋 View matches: ${WEB_URL}/matches.php\n\n` +
                       `Good luck! 🍀`;
        
        for (const groupId of groupIds) {
            try {
                await sock.sendMessage(groupId, { text: message });
                console.log(`✅ Daily reminder sent to ${groupId}`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(`❌ Failed to send to ${groupId}:`, error);
            }
        }
    } catch (error) {
        console.error('❌ Error sending daily reminder:', error);
    }
}

function scheduleDailyReminder() {
    const now = new Date();
    const uaeTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
    
    const targetTime = new Date(uaeTime);
    targetTime.setHours(9, 0, 0, 0);
    
    if (uaeTime > targetTime) {
        targetTime.setDate(targetTime.getDate() + 1);
    }
    
    const msUntilTarget = targetTime.getTime() - uaeTime.getTime();
    
    console.log(`⏰ Next daily reminder scheduled for: ${targetTime.toLocaleString('en-US', { timeZone: 'Asia/Dubai' })}`);
    
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
        
        // Save group if it's a group message
        if (isGroup) {
            await saveGroup(from);
        }
        
        // Get user info from the message
        const pushName = msgData.pushName || '';
        const waNumber = getUserId(sender);
        const displayName = pushName || waNumber;
        
        console.log(`📩 Received: "${text}" from ${displayName} (JID: ${sender})`);
        
        // ===== FETCH PROFILE PICTURE =====
        let profilePic = '';
        try {
            profilePic = await fetchProfilePicture(sock, sender);
            if (profilePic) {
                console.log(`✅ Profile picture URL: ${profilePic.substring(0, 60)}...`);
            }
        } catch (error) {
            console.error(`❌ Error fetching profile picture:`, error.message);
        }
        
        // ===== REGISTER USER =====
        await registerUserOnServer(waNumber, displayName, profilePic);
        
        const parts = text.split(' ');
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);
        
        // ===== VOTE COMMAND =====
        if (command === '!vote') {
            await handleVoteCommand(sock, from, sender, isGroup, waNumber, displayName);
            return;
        }
        
        // ===== GROUP ADMIN COMMANDS =====
        if (isGroup && command === '!creatematch') {
            await handleCreateMatchCommand(sock, from, text);
            return;
        }
        
        // ===== VIEW LEADERBOARD =====
        if (command === '!leaderboard' || command === '!standings') {
            await handleLeaderboardCommand(sock, from, waNumber);
            return;
        }
        
        // ===== VIEW MATCHES =====
        if (command === '!matches') {
            await handleMatchesCommand(sock, from, waNumber);
            return;
        }
        
        // ===== MATCH STATUS =====
        if (command === '!matchstatus' || command === '!votes') {
            await handleMatchStatusCommand(sock, from, waNumber);
            return;
        }
        
        // ===== USER STATS =====
        if (command === '!stats') {
            await handleStatsCommand(sock, from, waNumber);
            return;
        }
        
        // ===== ADMIN: CLOSE MATCH =====
        if (isGroup && command === '!closematch') {
            await handleCloseMatchCommand(sock, from, args);
            return;
        }
        
        // ===== ADMIN: DECLARE RESULT =====
        if (isGroup && command === '!declareresult') {
            await handleDeclareResultCommand(sock, from, text, args);
            return;
        }
        
        // ===== HELP =====
        if (command === '!help' || command === '!menu') {
            await handleHelpCommand(sock, from);
            return;
        }
    }
}

// ===== INDIVIDUAL COMMAND HANDLERS =====
async function handleVoteCommand(sock, from, sender, isGroup, waNumber, displayName) {
    const votingLink = `${WEB_URL}/index.php?wa=${waNumber}`;
    
    try {
        const match = await getActiveMatchFromServer();
        
        let messageText = '';
        if (match) {
            const fullLink = `${WEB_URL}/index.php?match=${match.id}&wa=${waNumber}`;
            messageText = `📱 *Your Personal Voting Link*\n\n` +
                         `Click the link below to vote:\n` +
                         `${fullLink}\n\n` +
                         `👤 *Name:* ${displayName}\n` +
                         `🆔 *Your ID:* ${waNumber}\n` +
                         `⚽ *Match:* ${match.name}\n` +
                         `⏰ *Kickoff:* ${new Date(match.kickoff).toLocaleString()}\n\n` +
                         `🔒 This link is personal to you.`;
        } else {
            messageText = `📱 *Your Personal Voting Link*\n\n` +
                         `Click the link below to vote:\n` +
                         `${votingLink}\n\n` +
                         `👤 *Name:* ${displayName}\n` +
                         `🆔 *Your ID:* ${waNumber}\n` +
                         `No active match found. Check back later!\n\n` +
                         `🔒 This link is personal to you.`;
        }
        
        // Send as PRIVATE message
        await sock.sendMessage(sender, { text: messageText });
        
        if (isGroup) {
            await sock.sendMessage(from, { 
                text: `✅ I've sent your personal voting link via private message. Check your DMs! 📩` 
            });
        }
        
    } catch (error) {
        console.error('Error in vote command:', error);
        await sock.sendMessage(sender, {
            text: `📱 Vote here:\n${WEB_URL}/index.php?wa=${waNumber}`
        });
        if (isGroup) {
            await sock.sendMessage(from, { 
                text: `✅ I've sent your personal voting link via private message. Check your DMs! 📩` 
            });
        }
    }
}

async function handleCreateMatchCommand(sock, from, text) {
    try {
        let matchName = '';
        let kickoffTime = '';
        let team1 = '';
        let team2 = '';
        
        const matchNameMatch = text.match(/"([^"]+)"/);
        if (matchNameMatch) {
            matchName = matchNameMatch[1];
            const teams = matchName.split(' vs ').map(t => t.trim());
            team1 = teams[0] || '';
            team2 = teams[1] || '';
        }
        
        const timeMatch = text.match(/"([^"]+)"$/);
        if (timeMatch) {
            kickoffTime = timeMatch[1];
        }
        
        if (!matchName || !kickoffTime || !team1 || !team2) {
            await sock.sendMessage(from, { 
                text: '❌ Usage: !creatematch "Team A vs Team B" "2026-06-20 15:00"' 
            });
            return;
        }
        
        const matchData = {
            id: Date.now().toString(),
            name: matchName,
            team1: team1,
            team2: team2,
            kickoff: new Date(kickoffTime).toISOString(),
            created_by: from
        };
        
        const result = await createMatchOnServer(matchData);
        
        if (result && result.success) {
            const votingLink = `${WEB_URL}/index.php?match=${matchData.id}`;
            await sock.sendMessage(from, {
                text: `✅ Match Created Successfully!\n\n📋 *${matchName}*\n⏰ Kickoff: ${new Date(kickoffTime).toLocaleString()}\n\n📱 Get your personal voting link by typing: !vote\n\n📱 Or vote here:\n${votingLink}`
            });
        } else {
            await sock.sendMessage(from, { text: '❌ Failed to create match. Please try again.' });
        }
    } catch (error) {
        console.error('Error in !creatematch:', error);
        await sock.sendMessage(from, { text: '❌ Error creating match. Check format!' });
    }
}

async function handleLeaderboardCommand(sock, from, waNumber) {
    try {
        const data = await getLeaderboardFromServer();
        
        if (!data || data.length === 0) {
            await sock.sendMessage(from, { 
                text: `📊 No points recorded yet!\n\nStart voting by typing: !vote` 
            });
            return;
        }
        
        let response = '🏆 *Leaderboard*\n\n';
        
        data.forEach((user, index) => {
            const name = user.name || user.wa_number || 'Anonymous';
            const isYou = user.wa_number === waNumber ? ' 👈' : '';
            const medals = ['🥇', '🥈', '🥉'];
            const medal = index < 3 ? medals[index] : `${index + 1}.`;
            response += `${medal} ${name}: ${user.total_points || 0} points${isYou}\n`;
            response += `   📊 ${user.correct_predictions || 0}/${user.total_predictions || 0} correct\n`;
        });
        
        response += `\n📱 Full leaderboard:\n${WEB_URL}/leaderboard.php`;
        response += `\n📱 Get your personal voting link: !vote`;
        
        await sock.sendMessage(from, { text: response });
    } catch (error) {
        console.error('Error in !leaderboard:', error);
        await sock.sendMessage(from, { text: '❌ Error fetching leaderboard. Please try again.' });
    }
}

async function handleMatchesCommand(sock, from, waNumber) {
    try {
        const matches = await getMatchesFromServer();
        
        if (!matches || matches.length === 0) {
            await sock.sendMessage(from, { text: '📋 No matches available!' });
            return;
        }
        
        let responseText = '📋 *Matches*\n\n';
        
        const upcoming = matches.filter(m => m.status === 'active' && new Date(m.kickoff) > new Date());
        if (upcoming.length > 0) {
            responseText += '🟢 *Upcoming Matches (Voting Open)*\n';
            upcoming.forEach(m => {
                const matchLink = `${WEB_URL}/index.php?match=${m.id}&wa=${waNumber}`;
                responseText += `📌 *${m.name}*\n`;
                responseText += `   ⏰ ${new Date(m.kickoff).toLocaleString()}\n`;
                responseText += `   🔗 Vote: ${matchLink}\n\n`;
            });
        }
        
        const completed = matches.filter(m => m.status === 'completed');
        if (completed.length > 0) {
            responseText += '🔵 *Completed Matches*\n';
            completed.slice(-3).forEach(m => {
                responseText += `📌 ${m.name}\n`;
                responseText += `   🏅 Winner: ${m.winner || 'Unknown'}\n`;
                responseText += `   ⚽ Score: ${m.score || 'N/A'}\n\n`;
            });
        }
        
        if (responseText === '📋 *Matches*\n\n') {
            responseText += 'No matches available.';
        }
        
        responseText += `\n📱 Get your personal voting link: !vote`;
        
        await sock.sendMessage(from, { text: responseText });
    } catch (error) {
        console.error('Error in !matches:', error);
        await sock.sendMessage(from, { text: '❌ Error fetching matches. Please try again.' });
    }
}

async function handleMatchStatusCommand(sock, from, waNumber) {
    try {
        const match = await getActiveMatchFromServer();
        
        if (!match) {
            await sock.sendMessage(from, { 
                text: `❌ No active match!\n\nType !matches to see all matches.` 
            });
            return;
        }
        
        const votes = await getMatchVotesFromServer(match.id);
        
        let responseText = `📊 *Voting Status*\n\n`;
        responseText += `📋 ${match.name}\n`;
        responseText += `⏰ ${new Date(match.kickoff).toLocaleString()}\n\n`;
        
        const team1Count = votes?.filter(v => v.team_voted === match.team1).length || 0;
        const team2Count = votes?.filter(v => v.team_voted === match.team2).length || 0;
        const totalVotes = team1Count + team2Count;
        
        const maxBarLength = 15;
        const bar1 = '█'.repeat(Math.min(Math.floor(team1Count / (totalVotes || 1) * maxBarLength), maxBarLength));
        const bar2 = '█'.repeat(Math.min(Math.floor(team2Count / (totalVotes || 1) * maxBarLength), maxBarLength));
        
        responseText += `🏆 ${match.team1}\n`;
        responseText += `${bar1 || ' '} ${team1Count} votes (${totalVotes > 0 ? Math.round((team1Count/totalVotes)*100) : 0}%)\n\n`;
        responseText += `🏆 ${match.team2}\n`;
        responseText += `${bar2 || ' '} ${team2Count} votes (${totalVotes > 0 ? Math.round((team2Count/totalVotes)*100) : 0}%)\n\n`;
        responseText += `📊 Total Votes: ${totalVotes}`;
        
        const userVote = votes?.find(v => v.wa_number === waNumber);
        if (userVote) {
            responseText += `\n\n✅ You voted for: ${userVote.team_voted}`;
        } else {
            responseText += `\n\n❌ You haven't voted yet!\nType !vote to get your personal voting link.`;
        }
        
        await sock.sendMessage(from, { text: responseText });
    } catch (error) {
        console.error('Error in !matchstatus:', error);
        await sock.sendMessage(from, { text: '❌ Error getting match status. Please try again.' });
    }
}

async function handleStatsCommand(sock, from, waNumber) {
    try {
        const user = await getUserStatsFromServer(waNumber);
        
        if (!user) {
            await sock.sendMessage(from, { 
                text: `📊 No stats found for your number.\nStart voting by typing: !vote` 
            });
            return;
        }
        
        let responseText = `📊 *Your Stats*\n\n`;
        responseText += `👤 Name: ${user.name || 'Not set'}\n`;
        responseText += `📱 Number: ${user.wa_number}\n`;
        responseText += `⭐ Total Points: ${user.total_points || 0}\n`;
        responseText += `✅ Correct Predictions: ${user.correct_predictions || 0}\n`;
        responseText += `📊 Total Predictions: ${user.total_predictions || 0}\n`;
        responseText += `📈 Accuracy: ${user.total_predictions > 0 ? Math.round((user.correct_predictions / user.total_predictions) * 100) : 0}%`;
        
        await sock.sendMessage(from, { text: responseText });
    } catch (error) {
        console.error('Error in !stats:', error);
        await sock.sendMessage(from, { text: '❌ Error fetching your stats.' });
    }
}

async function handleCloseMatchCommand(sock, from, args) {
    const matchId = args[0];
    if (!matchId) {
        await sock.sendMessage(from, { text: '❌ Usage: !closematch [match_id]' });
        return;
    }
    
    try {
        const result = await closeMatchOnServer(matchId);
        
        if (result && result.success) {
            await sock.sendMessage(from, {
                text: `🔒 Voting closed for match!\nMatch ID: ${matchId}\nResults will be announced soon.`
            });
        } else {
            await sock.sendMessage(from, { text: '❌ Failed to close match. Check match ID.' });
        }
    } catch (error) {
        console.error('Error in !closematch:', error);
        await sock.sendMessage(from, { text: '❌ Error closing match.' });
    }
}

async function handleDeclareResultCommand(sock, from, text, args) {
    try {
        const matchId = args[0];
        const teamName = args.slice(1, args.length - 1).join(' ').replace(/^"|"$/g, '');
        const score = args[args.length - 1];
        
        if (!matchId || !teamName || !score) {
            await sock.sendMessage(from, { 
                text: '❌ Usage: !declareresult [match_id] "Team Name" score' 
            });
            return;
        }
        
        const result = await declareResultOnServer(matchId, teamName, score);
        
        if (result && result.success) {
            const match = await getMatchFromServer(matchId);
            
            let response = `🏆 *Match Result Declared!*\n\n`;
            response += `📋 ${match?.name || 'Match'}\n`;
            response += `🏅 Winner: ${teamName}\n`;
            response += `⚽ Score: ${score}\n\n`;
            
            if (result.points_awarded && result.points_awarded.length > 0) {
                response += `🎉 *Points Awarded (3 points each)*\n`;
                result.points_awarded.forEach(user => {
                    response += `- ${user.name || user.wa_number}: +3 points\n`;
                });
            }
            
            await sock.sendMessage(from, { text: response });
        } else {
            await sock.sendMessage(from, { text: '❌ Failed to declare result.' });
        }
    } catch (error) {
        console.error('Error in !declareresult:', error);
        await sock.sendMessage(from, { text: '❌ Error declaring result.' });
    }
}

async function handleHelpCommand(sock, from) {
    const clickToChatLink = `https://wa.me/${BOT_NUMBER}?text=!vote`;
    
    let response = '📋 *Available Commands*\n\n';
    response += '👤 *User Commands*\n';
    response += '!vote - Get your personal voting link (private message)\n';
    response += '!matches - View all matches\n';
    response += '!leaderboard - View standings\n';
    response += '!stats - Your voting history\n';
    response += '!matchstatus - View current votes\n';
    response += '!help - Show this menu\n\n';
    
    response += '👑 *Admin Commands*\n';
    response += '!creatematch "Team A vs Team B" "YYYY-MM-DD HH:MM"\n';
    response += '!closematch [match_id]\n';
    response += '!declareresult [match_id] "Team Name" score\n\n';
    
    response += `📱 *Quick Vote:*\n`;
    response += `Click this link to vote instantly:\n${clickToChatLink}\n\n`;
    
    response += `🌐 *Web Dashboard:*\n`;
    response += `${WEB_URL}`;
    
    await sock.sendMessage(from, { text: response });
}

// ==================== EXPRESS SERVER ====================
app.use(express.json());
app.use(express.static('public'));

let currentQR = null;

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
                <p><small>Refresh this page if the QR code expires.</small></p>
            `);
        } catch (e) {
            res.send('<h2>Error generating QR. Please refresh.</h2>');
        }
    } else {
        res.send('<h2>Waiting for QR Code... Refresh after 5-10 seconds.</h2>');
    }
});

// ==================== BOT CONNECTION ====================
let sock;

// ==================== AUTO RESTART LOGIC ====================
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

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
            // Better settings for stability
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
                reconnectAttempts = 0;   // Reset counter on successful connection
                console.log('🤖 Connected to PHP server at:', API_URL);
                
                scheduleDailyReminder();
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                console.log(`❌ Connection closed. Status: ${statusCode}`);

                if (statusCode !== DisconnectReason.loggedOut) {
                    reconnectAttempts++;
                    
                    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                        const delay = Math.min(5000 * reconnectAttempts, 30000); // max 30 seconds
                        console.log(`🔄 Reconnecting in ${delay/1000} seconds... (Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
                        
                        setTimeout(connectToWhatsApp, delay);
                    } else {
                        console.log('🚨 Too many reconnection attempts. Restarting full process...');
                        reconnectAttempts = 0;
                        setTimeout(() => process.exit(1), 5000); // Force Render to restart the service
                    }
                } else {
                    console.log('❌ Logged out. Need to scan QR again.');
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        console.error('❌ Error in connectToWhatsApp:', error);
        reconnectAttempts++;
        if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            setTimeout(connectToWhatsApp, 10000);
        }
    }
}

// ==================== KEEP ALIVE ENDPOINT ====================
// Add this BEFORE app.listen
app.get('/ping', (req, res) => {
    res.status(200).json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage().heapUsed / 1024 / 1024 + ' MB',
        bot: sock ? 'connected' : 'disconnected'
    });
});

// ==================== BETTER KEEP ALIVE ====================
async function keepAlive() {
    const urls = [
        `http://localhost:${PORT}/ping`,
        `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'whatsapp-bot-v0ts.onrender.com'}/ping`
    ];

    for (const url of urls) {
        try {
            const res = await axios.get(url, { timeout: 10000 });
            console.log(`✅ Keep-alive OK → ${url}`);
            return;
        } catch (err) {
            console.log(`⚠️ Keep-alive failed: ${url}`);
        }
    }
}

// Run every 4 minutes
setInterval(keepAlive, 4 * 60 * 1000);
setTimeout(keepAlive, 15000); // Initial ping

// ==================== ORIGINAL CODE BELOW (KEEP THESE) ====================
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Web dashboard: ${WEB_URL}`);
    console.log(`📱 Bot Number: ${BOT_NUMBER}`);
});

// ==================== START BOT ====================
connectToWhatsApp();

// The old keep-alive is REPLACED by the new one above
// Remove or comment out the old setInterval
