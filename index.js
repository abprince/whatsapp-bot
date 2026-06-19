const express = require('express');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios'); // For API calls

const app = express();
const PORT = process.env.PORT || 10000;

// ==================== CONFIGURATION ====================
const API_URL = 'https://aramedia.me/worldcup/api.php'; // Your PHP API endpoint
const WEB_URL = 'https://aramedia.me/worldcup'; // Your PHP web server

// ==================== API FUNCTIONS ====================
// Function to create a match in your PHP/MySQL server
async function createMatchOnServer(matchData) {
    try {
        const response = await axios.post(`${API_URL}?action=create_match`, matchData);
        return response.data;
    } catch (error) {
        console.error('Error creating match:', error);
        return null;
    }
}

// Function to get match details from PHP/MySQL
async function getMatchFromServer(matchId) {
    try {
        const response = await axios.get(`${API_URL}?action=get_match&match_id=${matchId}`);
        return response.data;
    } catch (error) {
        console.error('Error getting match:', error);
        return null;
    }
}

// Function to get leaderboard from PHP/MySQL
async function getLeaderboardFromServer() {
    try {
        const response = await axios.get(`${API_URL}?action=get_leaderboard`);
        return response.data;
    } catch (error) {
        console.error('Error getting leaderboard:', error);
        return null;
    }
}

// Function to get match votes from PHP/MySQL
async function getMatchVotesFromServer(matchId) {
    try {
        const response = await axios.get(`${API_URL}?action=get_votes&match_id=${matchId}`);
        return response.data;
    } catch (error) {
        console.error('Error getting votes:', error);
        return null;
    }
}

// Function to declare match result
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

// ==================== COMMAND HANDLERS ====================
async function handleCommands(sock, msg) {
    const msgData = msg.messages[0];
    if (!msgData.key.fromMe && msgData.message?.conversation) {
        
        const text = msgData.message.conversation.trim();
        const from = msgData.key.remoteJid;
        const sender = msgData.key.participant || msgData.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        
        console.log(`📩 Received: ${text} from ${sender}`);
        
        // Parse command
        const parts = text.split(' ');
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);
        
        // ===== GROUP ADMIN COMMANDS =====
        if (isGroup && command === '!creatematch') {
            // !creatematch "Team A vs Team B" "2026-06-20 15:00"
            try {
                // Extract match name and kickoff time
                let matchName = '';
                let kickoffTime = '';
                let team1 = '';
                let team2 = '';
                
                // Simple parsing - you can make this more robust
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
                
                // Create match in PHP/MySQL
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
                        text: `✅ Match Created Successfully!\n\n📋 *${matchName}*\n⏰ Kickoff: ${new Date(kickoffTime).toLocaleString()}\n\n📱 Vote here:\n${votingLink}\n\nOr type !vote [team] to vote directly!`
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
            // Send voting link instead of processing vote directly
            const waNumber = sender.replace('@c.us', '').replace('@g.us', '');
            const votingLink = `${WEB_URL}/index.php?wa=${waNumber}`;
            
            // Check if there's an active match
            try {
                const response = await axios.get(`${API_URL}?action=get_active_match`);
                const match = response.data;
                
                if (match) {
                    const fullLink = `${WEB_URL}/index.php?match=${match.id}&wa=${waNumber}`;
                    await sock.sendMessage(from, {
                        text: `📱 Click here to vote:\n${fullLink}\n\nOr visit: ${WEB_URL}/index.php\n\n⚽ Current Match: ${match.name}`
                    });
                } else {
                    await sock.sendMessage(from, {
                        text: `📱 Vote here:\n${WEB_URL}/index.php\n\nNo active match found. Check back later!`
                    });
                }
            } catch (error) {
                await sock.sendMessage(from, {
                    text: `📱 Vote here:\n${WEB_URL}/index.php?wa=${waNumber}`
                });
            }
            return;
        }
        
        // ===== VIEW LEADERBOARD =====
        if (command === '!leaderboard' || command === '!standings') {
            try {
                const data = await getLeaderboardFromServer();
                
                if (!data || data.length === 0) {
                    await sock.sendMessage(from, { text: '📊 No points recorded yet!' });
                    return;
                }
                
                let response = '🏆 *Leaderboard*\n\n';
                data.forEach((user, index) => {
                    const name = user.name || user.wa_number || 'Anonymous';
                    response += `${index + 1}. ${name}: ${user.total_points || 0} points (${user.correct_predictions || 0}/${user.total_predictions || 0} correct)\n`;
                });
                
                await sock.sendMessage(from, { text: response });
            } catch (error) {
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
                
                let responseText = '📋 *Matches*\n\n';
                
                // Upcoming matches (voting open)
                const upcoming = matches.filter(m => m.status === 'active');
                if (upcoming.length > 0) {
                    responseText += '🟢 *Upcoming Matches (Voting Open)*\n';
                    upcoming.forEach(m => {
                        responseText += `📌 ${m.name}\n`;
                        responseText += `   ⏰ ${new Date(m.kickoff).toLocaleString()}\n`;
                        responseText += `   🆔: ${m.id}\n\n`;
                    });
                }
                
                // Completed matches
                const completed = matches.filter(m => m.status === 'completed');
                if (completed.length > 0) {
                    responseText += '🔵 *Completed Matches*\n';
                    completed.slice(-3).forEach(m => {
                        responseText += `📌 ${m.name}\n`;
                        responseText += `   🏅 Winner: ${m.winner || 'Unknown'}\n`;
                        responseText += `   ⚽ Score: ${m.score || 'N/A'}\n\n`;
                    });
                }
                
                await sock.sendMessage(from, { text: responseText });
            } catch (error) {
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
                    await sock.sendMessage(from, { text: '❌ No active match!' });
                    return;
                }
                
                // Get vote counts
                const votesResponse = await axios.get(`${API_URL}?action=get_votes&match_id=${match.id}`);
                const votes = votesResponse.data;
                
                let responseText = `📊 *Voting Status*\n\n📋 ${match.name}\n`;
                
                // Count votes per team
                const team1Count = votes.filter(v => v.team_voted === match.team1).length;
                const team2Count = votes.filter(v => v.team_voted === match.team2).length;
                const totalVotes = team1Count + team2Count;
                
                // Create visual bars
                const maxBarLength = 20;
                const bar1 = '█'.repeat(Math.min(Math.floor(team1Count / (totalVotes || 1) * maxBarLength), maxBarLength));
                const bar2 = '█'.repeat(Math.min(Math.floor(team2Count / (totalVotes || 1) * maxBarLength), maxBarLength));
                
                responseText += `\n🏆 ${match.team1}\n${bar1 || ' '} ${team1Count} votes`;
                responseText += `\n\n🏆 ${match.team2}\n${bar2 || ' '} ${team2Count} votes`;
                responseText += `\n\n📊 Total Votes: ${totalVotes}`;
                responseText += `\n⏰ Kickoff: ${new Date(match.kickoff).toLocaleString()}`;
                
                // Show if user already voted
                const waNumber = sender.replace('@c.us', '').replace('@g.us', '');
                const userVote = votes.find(v => v.wa_number === waNumber);
                if (userVote) {
                    responseText += `\n\n✅ You voted for: ${userVote.team_voted}`;
                } else {
                    responseText += `\n\n❌ You haven't voted yet!\nUse !vote to get the voting link.`;
                }
                
                await sock.sendMessage(from, { text: responseText });
            } catch (error) {
                await sock.sendMessage(from, { text: '❌ Error getting match status.' });
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
                        text: `📊 No stats found for your number (${waNumber}).\nStart voting to earn points!` 
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
                await sock.sendMessage(from, { text: '❌ Error closing match.' });
            }
            return;
        }
        
        // ===== ADMIN: DECLARE RESULT =====
        if (isGroup && command === '!declareresult') {
            // !declareresult match_id "Team Name" score
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
                    // Get match details to display
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
                await sock.sendMessage(from, { text: '❌ Error declaring result.' });
            }
            return;
        }
        
        // ===== HELP =====
        if (command === '!help' || command === '!menu') {
            let response = '📋 *Available Commands*\n\n';
            response += '👤 *User Commands*\n';
            response += '!vote - Get voting link\n';
            response += '!matches - View all matches\n';
            response += '!leaderboard - View standings\n';
            response += '!stats - Your voting history\n';
            response += '!matchstatus - View current votes\n';
            response += '!help - Show this menu\n\n';
            
            response += '👑 *Admin Commands*\n';
            response += '!creatematch "Team A vs Team B" "YYYY-MM-DD HH:MM"\n';
            response += '!closematch [match_id]\n';
            response += '!declareresult [match_id] "Team Name" score\n';
            
            response += `\n📱 Vote online: ${WEB_URL}`;
            
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
    res.send(`
        <h1>✅ WhatsApp Bot is Running!</h1>
        <p><a href="/qr" target="_blank"><b>👉 Click Here to Scan QR Code</b></a></p>
        <p><a href="https://aramedia.me/worldcup" target="_blank"><b>📊 View Dashboard</b></a></p>
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
    console.log(`🌐 Web dashboard: https://aramedia.me/worldcup`);
});

// ==================== START BOT ====================
connectToWhatsApp();

// Keep alive
setInterval(() => {
    console.log('🔄 Keep-alive ping');
}, 300000);