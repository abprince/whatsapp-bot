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
// ==================== API FUNCTIONS ====================
async function createMatchOnServer(matchData) {
    try {
        const response = await axios.post(`${API_URL}?action=create_match`, matchData);
        return response.data;
    } catch (error) {
        console.error('Error creating match:', error);
        return null;
    }
}

async function getMatchFromServer(matchId) {
    try {
        const response = await axios.get(`${API_URL}?action=get_match&match_id=${matchId}`);
        return response.data;
    } catch (error) {
        console.error('Error getting match:', error);
        return null;
    }
}

async function getLeaderboardFromServer() {
    try {
        const response = await axios.get(`${API_URL}?action=get_leaderboard`);
        return response.data;
    } catch (error) {
        console.error('Error getting leaderboard:', error);
        return null;
    }
}

async function getMatchVotesFromServer(matchId) {
    try {
        const response = await axios.get(`${API_URL}?action=get_votes&match_id=${matchId}`);
        return response.data;
    } catch (error) {
        console.error('Error getting votes:', error);
        return null;
    }
}

async function declareResultOnServer(matchId, winner, score) {
    try {
        const response = await axios.post(`${API_URL}?action=declare_result`, {
            match_id: matchId,
            winner: winner,
            score: score
        });
        return response.data;
    } catch (error) {
        console.error('Error declaring result:', error);
        return null;
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
        
        console.log(`📩 Received: "${text}" from ${sender}`);
        
        const parts = text.split(' ');
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);
        
        // ===== GROUP ADMIN COMMANDS =====
        if (isGroup && command === '!creatematch') {
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
                    created_by: sender
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
            return;
        }
        
        // ===== VOTING COMMAND =====
        if (command === '!vote') {
            const waNumber = sender.replace('@c.us', '').replace('@g.us', '');
            const votingLink = `${WEB_URL}/index.php?wa=${waNumber}`;
            
            try {
                const response = await axios.get(`${API_URL}?action=get_active_match`);
                const match = response.data;
                
                let messageText = '';
                if (match) {
                    const fullLink = `${WEB_URL}/index.php?match=${match.id}&wa=${waNumber}`;
                    messageText = `📱 *Your Personal Voting Link*\n\n` +
                                 `Click the link below to vote:\n` +
                                 `${fullLink}\n\n` +
                                 `⚽ *Match:* ${match.name}\n` +
                                 `⏰ *Kickoff:* ${new Date(match.kickoff).toLocaleString()}\n\n` +
                                 `🔒 This link is personal to you (${waNumber})`;
                } else {
                    messageText = `📱 *Your Personal Voting Link*\n\n` +
                                 `Click the link below to vote:\n` +
                                 `${votingLink}\n\n` +
                                 `No active match found. Check back later!\n\n` +
                                 `🔒 This link is personal to you (${waNumber})`;
                }
                
                // Send as PRIVATE message
                await sock.sendMessage(sender, { text: messageText });
                
                if (isGroup) {
                    await sock.sendMessage(from, { 
                        text: `✅ I've sent your personal voting link via private message. Check your DMs! 📩` 
                    });
                }
                
            } catch (error) {
                console.error('Error in !vote:', error);
                await sock.sendMessage(sender, {
                    text: `📱 Vote here:\n${WEB_URL}/index.php?wa=${waNumber}`
                });
                if (isGroup) {
                    await sock.sendMessage(from, { 
                        text: `✅ I've sent your personal voting link via private message. Check your DMs! 📩` 
                    });
                }
            }
            return;
        }
        
        // ===== VIEW LEADERBOARD =====
        if (command === '!leaderboard' || command === '!standings') {
            try {
                const data = await getLeaderboardFromServer();
                
                if (!data || data.length === 0) {
                    await sock.sendMessage(from, { 
                        text: `📊 No points recorded yet!\n\nStart voting by typing: !vote` 
                    });
                    return;
                }
                
                const waNumber = sender.replace('@c.us', '').replace('@g.us', '');
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
            return;
        }
        
        // ===== VIEW MATCHES =====
        if (command === '!matches') {
            try {
                const response = await axios.get(`${API_URL}?action=get_matches`);
                const matches = response.data;
                
                if (!matches || matches.length === 0) {
                    await sock.sendMessage(from, { text: '📋 No matches available!' });
                    return;
                }
                
                const waNumber = sender.replace('@c.us', '').replace('@g.us', '');
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
            return;
        }
        
        // ===== MATCH STATUS =====
        if (command === '!matchstatus' || command === '!votes') {
            try {
                const response = await axios.get(`${API_URL}?action=get_active_match`);
                const match = response.data;
                
                if (!match) {
                    await sock.sendMessage(from, { 
                        text: `❌ No active match!\n\nType !matches to see all matches.` 
                    });
                    return;
                }
                
                const votesResponse = await axios.get(`${API_URL}?action=get_votes&match_id=${match.id}`);
                const votes = votesResponse.data;
                
                const waNumber = sender.replace('@c.us', '').replace('@g.us', '');
                
                let responseText = `📊 *Voting Status*\n\n`;
                responseText += `📋 ${match.name}\n`;
                responseText += `⏰ ${new Date(match.kickoff).toLocaleString()}\n\n`;
                
                const team1Count = votes.filter(v => v.team_voted === match.team1).length;
                const team2Count = votes.filter(v => v.team_voted === match.team2).length;
                const totalVotes = team1Count + team2Count;
                
                const maxBarLength = 15;
                const bar1 = '█'.repeat(Math.min(Math.floor(team1Count / (totalVotes || 1) * maxBarLength), maxBarLength));
                const bar2 = '█'.repeat(Math.min(Math.floor(team2Count / (totalVotes || 1) * maxBarLength), maxBarLength));
                
                responseText += `🏆 ${match.team1}\n`;
                responseText += `${bar1 || ' '} ${team1Count} votes (${totalVotes > 0 ? Math.round((team1Count/totalVotes)*100) : 0}%)\n\n`;
                responseText += `🏆 ${match.team2}\n`;
                responseText += `${bar2 || ' '} ${team2Count} votes (${totalVotes > 0 ? Math.round((team2Count/totalVotes)*100) : 0}%)\n\n`;
                responseText += `📊 Total Votes: ${totalVotes}`;
                
                const userVote = votes.find(v => v.wa_number === waNumber);
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
            return;
        }
        
        // ===== USER STATS =====
        if (command === '!stats') {
            const waNumber = sender.replace('@c.us', '').replace('@g.us', '');
            try {
                const response = await axios.get(`${API_URL}?action=get_user_stats&wa_number=${waNumber}`);
                const user = response.data;
                
                if (!user) {
                    await sock.sendMessage(from, { 
                        text: `📊 No stats found for your number (${waNumber}).\nStart voting by typing: !vote` 
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
            return;
        }
        
        // ===== ADMIN: CLOSE MATCH =====
        if (isGroup && command === '!closematch') {
            const matchId = args[0];
            if (!matchId) {
                await sock.sendMessage(from, { text: '❌ Usage: !closematch [match_id]' });
                return;
            }
            
            try {
                const response = await axios.post(`${API_URL}?action=close_match`, {
                    match_id: matchId
                });
                
                if (response.data && response.data.success) {
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
            return;
        }
        
        // ===== ADMIN: DECLARE RESULT =====
        if (isGroup && command === '!declareresult') {
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
                    response += `📋 ${match.name}\n`;
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
            return;
        }
        
        // ===== HELP =====
        if (command === '!help' || command === '!menu') {
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
            return;
        }
    }
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
        <p>Groups: <span id="groupCount">0</span></p>
        <script>
            fetch('/groups')
                .then(res => res.json())
                .then(data => {
                    document.getElementById('groupCount').textContent = data.length;
                });
        </script>
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

app.get('/groups', (req, res) => {
    try {
        if (fs.existsSync('groups.json')) {
            const data = fs.readFileSync('groups.json', 'utf8');
            res.json(JSON.parse(data));
        } else {
            res.json([]);
        }
    } catch (error) {
        res.json([]);
    }
});

// ==================== BOT CONNECTION ====================
let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            console.log('📱 New QR Code Generated');
        }

        if (connection === 'open') {
            console.log('✅ Bot is Online!');
            currentQR = null;
            console.log('🤖 Connected to PHP server at:', API_URL);
            console.log(`📱 Bot Number: ${BOT_NUMBER}`);
            console.log(`🔗 Click-to-chat: https://wa.me/${BOT_NUMBER}?text=!vote`);
            
            // Start daily reminder schedule when bot connects
            scheduleDailyReminder();
        }

        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnecting in 10 seconds...');
                setTimeout(connectToWhatsApp, 10000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Message handler
    sock.ev.on('messages.upsert', async (m) => {
        await handleCommands(sock, m);
    });

    return sock;
}

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Web dashboard: ${WEB_URL}`);
});

// ==================== START BOT ====================
connectToWhatsApp();

// Keep alive
setInterval(() => {
    console.log('🔄 Keep-alive ping');
}, 300000);