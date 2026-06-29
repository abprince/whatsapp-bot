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
let reminderScheduled = false;
let reminderInterval = null;
let matchReminderInterval = null;
let pointsCheckInterval = null;
let errorCount = 0;
const MAX_ERRORS = 10;
let sentMatchReminders = {};
let sentPointsAnnouncements = {};

// ===== FIX: Daily reminder tracking =====
let reminderSentToday = false;
let lastReminderDate = null;

// ==================== CACHE SYSTEM ====================
let matchesCache = [];
let lastCacheUpdate = null;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

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

function formatTime(timeString) {
    if (!timeString || timeString === 'TBD') return 'TBD';
    try {
        const date = new Date(timeString);
        return date.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit',
            timeZone: 'Asia/Dubai'
        });
    } catch {
        return timeString;
    }
}

function getStatusEmoji(status) {
    const statusMap = {
        'live': '🔴',
        'in_progress': '🔴',
        'halftime': '⏸️',
        'completed': '✅',
        'scheduled': '⏳',
        'active': '🟢'
    };
    return statusMap[status] || '⏳';
}

// ==================== CACHED API FUNCTIONS ====================
async function getMatchesWithCache(forceRefresh = false) {
    const now = Date.now();
    
    if (!forceRefresh && lastCacheUpdate && (now - lastCacheUpdate) < CACHE_TTL) {
        console.log(`📊 Using cached matches (${matchesCache.length} matches)`);
        return matchesCache;
    }
    
    console.log('📡 Fetching fresh matches data...');
    const data = await apiRequest('get_matches');
    
    if (data && Array.isArray(data)) {
        matchesCache = data;
        lastCacheUpdate = now;
        console.log(`✅ Cached ${matchesCache.length} matches`);
    } else {
        if (matchesCache.length > 0) {
            console.log('⚠️ API failed, using stale cache');
            return matchesCache;
        }
        matchesCache = [];
    }
    
    return matchesCache;
}

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

// ==================== API FUNCTIONS ====================
async function getLeaderboardFromServer() { return await apiRequest('get_leaderboard'); }
async function getMatchVotesFromServer(matchId) { return await apiRequest(`get_votes&match_id=${matchId}`); }
async function getActiveMatchFromServer() { return await apiRequest('get_active_match'); }
async function getUserStatsFromServer(waNumber) { return await apiRequest(`get_user_stats&wa_number=${waNumber}`); }
async function getMatchesFromServer() { return await apiRequest('get_matches'); }
async function getPollsFromServer() { return await apiRequest('get_polls'); }
async function getPollDetailsFromServer(pollId) { return await apiRequest(`get_poll&poll_id=${pollId}`); }
async function registerUserOnServer(waNumber, name = '', profilePic = '') {
    console.log(`📝 Registering: ${waNumber}, Name: ${name}, Has Pic: ${profilePic ? '✅' : '❌'}`);
    return await apiRequest('register_user', 'POST', { wa_number: waNumber, name: name, profile_pic: profilePic });
}
async function getActiveMatchCount() {
    const matches = await getMatchesWithCache();
    return matches ? matches.filter(m => m.status === 'active').length : 0;
}

// ==================== EXPRESS ROUTES ====================
app.use(express.json());
app.use(express.static('public'));

app.get('/keep-alive', (req, res) => {
    res.status(200).send('OK');
});

app.get('/ping', (req, res) => res.status(200).json({}));
app.get('/health', (req, res) => res.status(200).json({}));
app.get('/debug', (req, res) => {
    res.json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        bot: sock ? 'connected' : 'disconnected',
        cache: {
            matches: matchesCache.length,
            lastUpdate: lastCacheUpdate ? new Date(lastCacheUpdate).toISOString() : null
        },
        reminder: {
            sentToday: reminderSentToday,
            lastSent: lastReminderDate
        }
    });
});

app.get('/', (req, res) => {
    const clickToChatLink = `https://wa.me/${BOT_NUMBER}?text=!help`;
    res.send(`
        <h1>✅ WhatsApp Bot is Running!</h1>
        <p><a href="/qr" target="_blank"><b>👉 Click Here to Scan QR Code</b></a></p>
        <hr>
        <h3>📱 Click-to-Chat Link:</h3>
        <p><a href="${clickToChatLink}" target="_blank">${clickToChatLink}</a></p>
        <hr>
        <p><a href="${WEB_URL}" target="_blank"><b>📊 View Dashboard</b></a></p>
        <p>Bot Number: ${BOT_NUMBER}</p>
        <p>Daily Reminder: ${reminderSentToday ? '✅ Sent today' : '⏳ Not sent yet'}</p>
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
    try {
        await axios.get(`http://localhost:${PORT}/keep-alive`, { timeout: 5000 });
    } catch (err) {}
}

setInterval(keepAlive, 5 * 60 * 1000);
setTimeout(keepAlive, 10000);

// ==================== SAFE EXECUTE WRAPPER ====================
async function safeExecute(fn, name) {
    try {
        await fn();
        errorCount = 0;
    } catch (error) {
        errorCount++;
        console.error(`❌ Error in ${name}:`, error.message);
        
        if (errorCount >= MAX_ERRORS && sock) {
            try {
                await sock.sendMessage(`${BOT_NUMBER}@s.whatsapp.net`, {
                    text: `⚠️ *Alert:* Bot has encountered ${MAX_ERRORS} errors in ${name}. Please check logs.`
                });
            } catch (e) {}
            errorCount = 0;
        }
    }
}

// ==================== AUTO RESTART LOGIC ====================
async function connectToWhatsApp() {
    console.log('🔄 Connecting to WhatsApp via DB Session Management...');
    try {
        if (!fs.existsSync('auth_info')) {
            fs.mkdirSync('auth_info');
        }

        console.log('📡 Syncing session state from PHP API...');
        const dbSessionData = await apiRequest('get_session');
        
        if (dbSessionData && dbSessionData.session) {
            console.log('🔑 Active session found in Database. Syncing locally...');
            fs.writeFileSync('auth_info/creds.json', dbSessionData.session, 'utf8');
        } else {
            console.log('⚠️ No session credentials found in Database. Fresh QR code required.');
        }

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
                console.log('✅ Bot is Online & Fully Authenticated!');
                currentQR = null;
                reconnectAttempts = 0;
                
                await autoDiscoverGroups();
                
                // ===== FIX: Only schedule if not already scheduled =====
                if (!reminderScheduled) {
                    reminderScheduled = false; // Reset to allow scheduling
                    scheduleDailyReminder();
                    scheduleMatchReminders();
                    schedulePointsAnnouncements();
                    await getMatchesWithCache(true);
                } else {
                    console.log('⏰ Reminders already scheduled, skipping...');
                }
            }
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`❌ Connection closed. Status: ${statusCode}`);
                
                // Reset flags on reconnect
                reminderScheduled = false;
                reminderSentToday = false;
                
                if (statusCode !== DisconnectReason.loggedOut) {
                    reconnectAttempts++;
                    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                        const delay = Math.min(5000 * reconnectAttempts, 30000);
                        setTimeout(connectToWhatsApp, delay);
                    } else {
                        setTimeout(() => process.exit(1), 3000);
                    }
                } else {
                    console.log('❌ Logged out. Need to scan QR again.');
                }
            }
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            try {
                if (fs.existsSync('auth_info/creds.json')) {
                    const currentCredsStr = fs.readFileSync('auth_info/creds.json', 'utf8');
                    await apiRequest('save_session', 'POST', { session: currentCredsStr });
                }
            } catch (err) {
                console.error('❌ Failed to update session backup in DB:', err.message);
            }
        });

        sock.ev.on('messages.upsert', async (m) => await safeExecute(() => handleCommands(sock, m), 'handleCommands'));
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

// ==================== AUTO DISCOVER GROUPS ====================
async function autoDiscoverGroups() {
    try {
        console.log('🔍 Auto-discovering groups...');
        
        if (!sock) {
            console.log('⚠️ Bot not connected, cannot discover groups');
            return;
        }
        
        const groups = await sock.groupFetchAllParticipating();
        
        if (!groups || Object.keys(groups).length === 0) {
            console.log('⚠️ No groups found. Bot may not be in any groups yet.');
            console.log('📝 Please add bot to a group and send !help to save it.');
            return;
        }
        
        let savedCount = 0;
        for (const groupId of Object.keys(groups)) {
            const groupInfo = groups[groupId];
            if (groupInfo.participants && groupInfo.participants.length > 0) {
                await saveGroup(groupId);
                savedCount++;
                console.log(`📝 Saved group: ${groupId} (${groupInfo.participants.length} members)`);
            }
        }
        
        console.log(`✅ Auto-discovered and saved ${savedCount} groups`);
        
        const groupIds = await getGroupIds();
        console.log(`📊 Total groups in database: ${groupIds.length}`);
        
        if (groupIds.length === 0) {
            console.log('⚠️ No groups saved. Please add bot to a WhatsApp group.');
        }
        
    } catch (error) {
        console.error('❌ Error auto-discovering groups:', error);
        console.log('📝 If error persists, manually add groups to groups.json file');
    }
}

// ==================== DAILY REMINDER (FIXED - ONLY ONCE PER DAY) ====================
async function sendDailyReminder() {
    // ===== FIX: Only send once per day =====
    const today = new Date().toDateString();
    
    // If already sent today, skip
    if (reminderSentToday && lastReminderDate === today) {
        console.log(`⏰ Daily reminder already sent today (${today}), skipping...`);
        return;
    }
    
    try {
        console.log('⏰ Sending daily reminder...');
        const groupIds = await getGroupIds();
        if (groupIds.length === 0) {
            console.log('⚠️ No groups found, skipping reminder');
            return;
        }
        
        const pollLink = `${WEB_URL}/vote.php`;
        let matchInfo = '';
        try {
            const response = await axios.get(`${API_URL}?action=get_today_matches`);
            const data = response.data;
            if (data.success && data.count > 0) {
                matchInfo = '\n\n📅 *Today\'s Matches:*\n';
                data.matches.slice(0, 5).forEach(m => {
                    const time = m.kickoff || m.date || 'TBD';
                    matchInfo += `• ${m.homeTeam} vs ${m.awayTeam} (${formatTime(time)})\n`;
                });
                if (data.count > 5) {
                    matchInfo += `\n... and ${data.count - 5} more matches`;
                }
            }
        } catch (e) {}
        
        const message = `🌅 *Good Morning!* 🌅\n\n⚽ *World Cup Predictions*\n\n📊 *Today's Poll is Open!*\n\nClick below to submit your predictions:\n🔗 ${pollLink}${matchInfo}\n\n📊 Rankings: ${WEB_URL}/leaderboard.php\n\nGood luck! 🍀`;
        
        // Use a Set to track sent groups (prevent duplicates)
        const sentGroups = new Set();
        
        for (const groupId of groupIds) {
            // Skip if already sent to this group
            if (sentGroups.has(groupId)) {
                console.log(`⏭️ Skipping duplicate for ${groupId}`);
                continue;
            }
            
            try {
                await sock.sendMessage(groupId, { text: message });
                sentGroups.add(groupId);
                console.log(`✅ Reminder sent to: ${groupId}`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (error) {
                console.error(`❌ Failed to send to ${groupId}:`, error.message);
            }
        }
        
        // ===== MARK AS SENT TODAY =====
        reminderSentToday = true;
        lastReminderDate = today;
        
        console.log(`✅ Daily reminder completed! Sent to ${sentGroups.size} groups`);
        
    } catch (error) {
        console.error('❌ Error sending daily reminder:', error);
    }
}

function scheduleDailyReminder() {
    if (reminderScheduled) {
        console.log('⏰ Daily reminder already scheduled, skipping...');
        return;
    }
    
    if (reminderInterval) {
        clearInterval(reminderInterval);
        reminderInterval = null;
    }
    
    // Reset the daily flag at midnight
    const resetDailyFlag = () => {
        const today = new Date().toDateString();
        if (lastReminderDate !== today) {
            reminderSentToday = false;
        }
    };
    
    // Check and reset daily flag every hour
    setInterval(resetDailyFlag, 60 * 60 * 1000);
    
    // UAE is UTC+4 (no DST)
    const now = new Date();
    const uaeMs = now.getTime() + (4 * 60 * 60 * 1000);
    const uaeNow = new Date(uaeMs);
    
    // Target: 11:00 AM UAE
    const targetMs = new Date(uaeNow);
    targetMs.setHours(11, 0, 0, 0);
    targetMs.setMinutes(0);
    targetMs.setSeconds(0);
    targetMs.setMilliseconds(0);
    
    // If past 11 AM, add a day
    if (uaeNow.getHours() >= 11) {
        targetMs.setDate(targetMs.getDate() + 1);
    }
    
    const msUntilTarget = targetMs.getTime() - uaeNow.getTime();
    
    // Convert back to Date objects for logging
    const displayNow = new Date(uaeNow.getTime() - (4 * 60 * 60 * 1000));
    const displayTarget = new Date(targetMs.getTime() - (4 * 60 * 60 * 1000));
    
    console.log(`⏰ Current UAE time: ${displayNow.toLocaleString('en-US', { timeZone: 'Asia/Dubai', hour12: false })}`);
    console.log(`⏰ Daily reminder scheduled for: ${displayTarget.toLocaleString('en-US', { timeZone: 'Asia/Dubai', hour12: false })} UAE time`);
    console.log(`⏰ Will run in ${Math.round(msUntilTarget / 60000)} minutes`);
    
    reminderScheduled = true;
    
    setTimeout(() => {
        // Reset the flag before sending (in case it's a new day)
        reminderSentToday = false;
        sendDailyReminder();
        
        // Set up the daily interval
        reminderInterval = setInterval(() => {
            // Reset flag for new day before sending
            const today = new Date().toDateString();
            if (lastReminderDate !== today) {
                reminderSentToday = false;
            }
            sendDailyReminder();
        }, 24 * 60 * 60 * 1000);
    }, msUntilTarget);
}

// ==================== POLL MATCHES FILTER ====================
async function getPollMatchIds() {
    try {
        console.log('🔍 Fetching poll match IDs...');
        const polls = await getPollsFromServer();
        
        if (!polls || polls.length === 0) {
            console.log('📊 No polls found');
            return [];
        }
        
        const activePolls = polls.filter(p => p.status === 'active');
        if (activePolls.length === 0) {
            console.log('📊 No active polls found');
            return [];
        }
        
        console.log(`📊 Found ${activePolls.length} active polls`);
        
        let allMatchIds = [];
        
        for (const poll of activePolls) {
            const pollDetails = await getPollDetailsFromServer(poll.id);
            if (pollDetails && pollDetails.matches) {
                const matchIds = pollDetails.matches.map(m => m.id);
                allMatchIds = [...allMatchIds, ...matchIds];
                console.log(`📊 Poll ${poll.id} has ${matchIds.length} matches`);
            }
        }
        
        const uniqueIds = [...new Set(allMatchIds)];
        console.log(`📊 Total unique match IDs in polls: ${uniqueIds.length}`);
        return uniqueIds;
    } catch (error) {
        console.error('❌ Error getting poll match IDs:', error);
        return [];
    }
}

async function getMatchesFromActivePolls() {
    const pollMatchIds = await getPollMatchIds();
    if (pollMatchIds.length === 0) {
        console.log('📊 No match IDs found in active polls');
        return [];
    }
    
    const allMatches = await getMatchesWithCache();
    const filteredMatches = allMatches.filter(m => pollMatchIds.includes(m.id));
    console.log(`📊 Found ${filteredMatches.length} matches from active polls`);
    return filteredMatches;
}

// ==================== MATCH REMINDER (1 Hour Before Kickoff) ====================
async function checkAndSendMatchReminders() {
    try {
        console.log('⏰ Checking for upcoming match reminders...');
        
        const matches = await getMatchesFromActivePolls();
        if (!matches || matches.length === 0) {
            console.log('📊 No matches found in active polls');
            return;
        }

        const now = new Date();
        const groupIds = await getGroupIds();
        if (groupIds.length === 0) {
            console.log('⚠️ No groups found, skipping match reminders');
            return;
        }

        let remindersSent = 0;

        for (const match of matches) {
            if (sentMatchReminders[match.id]) continue;

            const kickoff = new Date(match.kickoff);
            const timeDiff = (kickoff - now) / (1000 * 60);

            if (timeDiff > 55 && timeDiff <= 65) {
                const message = `⏰ *Match Starting Soon!*\n\n` +
                    `⚽ ${match.team1} vs ${match.team2}\n` +
                    `⏰ Kickoff in ${Math.round(timeDiff)} minutes\n` +
                    `📊 ${getStatusEmoji('active')} Status: Upcoming\n\n` +
                    `🗳️ Don't forget to vote!\n` +
                    `🔗 ${WEB_URL}/vote.php`;

                for (const groupId of groupIds) {
                    try {
                        await sock.sendMessage(groupId, { text: message });
                        console.log(`✅ Match reminder sent for: ${match.team1} vs ${match.team2}`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } catch (error) {
                        console.error(`❌ Failed to send match reminder to ${groupId}:`, error.message);
                    }
                }

                sentMatchReminders[match.id] = true;
                remindersSent++;
                
                const keys = Object.keys(sentMatchReminders);
                if (keys.length > 50) {
                    const sorted = keys.sort();
                    const toRemove = sorted.slice(0, keys.length - 50);
                    toRemove.forEach(key => delete sentMatchReminders[key]);
                }
            }
        }

        if (remindersSent > 0) {
            console.log(`✅ Sent ${remindersSent} match reminders`);
        }
    } catch (error) {
        console.error('❌ Error checking match reminders:', error);
    }
}

function scheduleMatchReminders() {
    if (matchReminderInterval) {
        clearInterval(matchReminderInterval);
        matchReminderInterval = null;
    }
    
    console.log('⏰ Match reminder checker scheduled (runs every 10 minutes)');
    matchReminderInterval = setInterval(() => {
        safeExecute(checkAndSendMatchReminders, 'checkAndSendMatchReminders');
    }, 10 * 60 * 1000);
}

// ==================== POINTS ANNOUNCEMENT (WITH USER NAMES) ====================
async function checkAndSendPointsAnnouncements() {
    try {
        console.log('🏆 Checking for new match results to announce...');
        
        const matches = await getMatchesFromActivePolls();
        if (!matches || matches.length === 0) {
            console.log('📊 No matches found in active polls');
            return;
        }

        const completedMatches = matches.filter(m => 
            m.status === 'completed' && 
            m.home_score !== undefined && 
            m.away_score !== undefined
        );

        if (completedMatches.length === 0) {
            console.log('📊 No completed matches found in active polls');
            return;
        }

        const groupIds = await getGroupIds();
        if (groupIds.length === 0) {
            console.log('⚠️ No groups found, skipping points announcements');
            return;
        }

        let announcementsSent = 0;

        for (const match of completedMatches) {
            if (sentPointsAnnouncements[match.id]) continue;

            const lastUpdate = new Date(match.last_score_update || match.updated_at || Date.now());
            const timeSinceUpdate = (Date.now() - lastUpdate.getTime()) / (1000 * 60);

            if (timeSinceUpdate > 120) {
                sentPointsAnnouncements[match.id] = true;
                continue;
            }

            const votes = await getMatchVotesFromServer(match.id) || [];
            const totalVotes = votes.length;
            const correctVotes = votes.filter(v => v.points_earned === 3).length;
            const wrongVotes = totalVotes - correctVotes;

            // 🔥 FIX: Get user names for correct voters
            const correctUsers = [];
            const correctVoters = votes.filter(v => v.points_earned === 3);
            
            for (const voter of correctVoters) {
                let userName = voter.name || voter.wa_number;
                
                // If name is not available in the vote object, fetch from users table
                if (!voter.name || voter.name === voter.wa_number) {
                    const userStats = await getUserStatsFromServer(voter.wa_number);
                    if (userStats && userStats.name) {
                        userName = userStats.name;
                    }
                }
                correctUsers.push(userName);
            }
            
            // Get top 3
            const topUsers = correctUsers.slice(0, 3);

            const winner = match.winner || 'Draw';
            const score = match.score || `${match.home_score || 0}-${match.away_score || 0}`;

            let message = `🏆 *Match Result Announced!*\n\n` +
                `⚽ ${match.team1} vs ${match.team2}\n` +
                `📊 Score: ${score}\n` +
                `🏅 Winner: ${winner}\n\n` +
                `📈 *Voting Stats:*\n` +
                `✅ Correct predictions: ${correctVotes}\n` +
                `❌ Wrong predictions: ${wrongVotes}\n` +
                `📊 Total votes: ${totalVotes}\n`;

            if (topUsers.length > 0) {
                message += `\n👏 *Top Predictors:*\n`;
                topUsers.forEach((user, i) => {
                    message += `${i+1}. ${user}\n`;
                });
            }

            if (winner !== 'Draw') {
                message += `\n🎯 ${correctVotes} users earned 3 points!`;
            } else {
                message += `\n🤝 Match ended in a draw. No points awarded.`;
            }

            message += `\n\n📊 Check rankings: ${WEB_URL}/leaderboard.php`;

            for (const groupId of groupIds) {
                try {
                    await sock.sendMessage(groupId, { text: message });
                    console.log(`✅ Points announcement sent for: ${match.team1} vs ${match.team2}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    console.error(`❌ Failed to send points announcement to ${groupId}:`, error.message);
                }
            }

            sentPointsAnnouncements[match.id] = true;
            announcementsSent++;

            const keys = Object.keys(sentPointsAnnouncements);
            if (keys.length > 50) {
                const sorted = keys.sort();
                const toRemove = sorted.slice(0, keys.length - 50);
                toRemove.forEach(key => delete sentPointsAnnouncements[key]);
            }
        }

        if (announcementsSent > 0) {
            console.log(`✅ Sent ${announcementsSent} points announcements`);
        }
    } catch (error) {
        console.error('❌ Error checking points announcements:', error);
    }
}

function schedulePointsAnnouncements() {
    if (pointsCheckInterval) {
        clearInterval(pointsCheckInterval);
        pointsCheckInterval = null;
    }
    
    console.log('🏆 Points announcement checker scheduled (runs every 10 minutes)');
    pointsCheckInterval = setInterval(() => {
        safeExecute(checkAndSendPointsAnnouncements, 'checkAndSendPointsAnnouncements');
    }, 10 * 60 * 1000);
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
        
        if (command === '!vote') return await handleVoteCommand(sock, from, sender, isGroup, waNumber, displayName);
        if (command === '!poll') return await handlePollCommand(sock, from);
        if (command === '!rank' || command === '!leaderboard') return await handleRankCommand(sock, from, waNumber);
        if (command === '!points' || command === '!mypoints') return await handlePointsCommand(sock, from, waNumber);
        if (command === '!schedule') return await handleScheduleCommand(sock, from);
        if (command === '!results') return await handleResultsCommand(sock, from);
        if (command === '!stats') return await handleStatsCommand(sock, from, waNumber);
        if (command === '!status') return await handleStatusCommand(sock, from);
        if (command === '!help' || command === '!menu') return await handleHelpCommand(sock, from);
    }
}

// ==================== COMMAND FUNCTIONS ====================

async function handleVoteCommand(sock, from, sender, isGroup, waNumber, displayName) {
    const votingLink = `${WEB_URL}/vote.php?wa=${waNumber}`;
    try {
        const match = await getActiveMatchFromServer();
        let messageText = '';
        if (match) {
            const fullLink = `${WEB_URL}/vote.php?match=${match.id}&wa=${waNumber}`;
            messageText = `📱 *Your Personal Voting Link*\n\nClick the link below to vote:\n${fullLink}\n\n👤 Name: ${displayName}\n🆔 ID: ${waNumber}\n⚽ Match: ${match.name}\n⏰ Kickoff: ${new Date(match.kickoff).toLocaleString()}\n\n🔒 This link is personal to you.`;
        } else {
            messageText = `📱 *Your Personal Voting Link*\n\nClick the link below to vote:\n${votingLink}\n\n👤 Name: ${displayName}\n🆔 ID: ${waNumber}\nNo active match found.`;
        }
        await sock.sendMessage(sender, { text: messageText });
        if (isGroup) await sock.sendMessage(from, { text: `✅ I've sent your personal voting link via private message. Check your DMs! 📩` });
    } catch (error) {
        console.error('Error in vote command:', error);
        await sock.sendMessage(from, { text: '⚠️ Error generating voting link. Please try again.' });
    }
}

async function handlePollCommand(sock, from) {
    try {
        const polls = await getPollsFromServer();
        if (!polls || polls.length === 0) {
            return await sock.sendMessage(from, { text: "❌ No polls available right now." });
        }

        const activePollSummary = polls.find(p => p.status === 'active');
        if (!activePollSummary) {
            return await sock.sendMessage(from, { text: "❌ No active polls found at the moment." });
        }

        const activePoll = await getPollDetailsFromServer(activePollSummary.id);
        if (!activePoll || !activePoll.matches || activePoll.matches.length === 0) {
            return await sock.sendMessage(from, { text: `📋 *${activePollSummary.name}*\n\nNo matches found in this poll execution.` });
        }

        const leaderboardUsers = await getLeaderboardFromServer() || [];
        
        let responseText = `📝 *${activePoll.name}*\n\n`;
        let index = 1;
        let totalMentions = [];

        for (const match of activePoll.matches) {
            if (!match) continue;
            
            responseText += `*Match ${index}:*\n⚽ ${match.team1} vs ${match.team2}\n`;

            const votes = await getMatchVotesFromServer(match.id) || [];
            const votedUserIds = votes.map(v => String(v.wa_number));

            let missingVotersNames = [];
            for (const user of leaderboardUsers) {
                const userIdStr = String(user.wa_number);
                
                if (!votedUserIds.includes(userIdStr)) {
                    const userName = user.name || user.wa_number;
                    missingVotersNames.push(userName);
                    
                    if (user.mob_number) {
                        const cleanMobile = String(user.mob_number).replace(/\D/g, '');
                        const mentionJid = `${cleanMobile}@s.whatsapp.net`;
                        if (!totalMentions.includes(mentionJid)) {
                            totalMentions.push(mentionJid);
                        }
                    }
                }
            }

            if (missingVotersNames.length > 0) {
                responseText += `⏳ *Pending Votes:* ${missingVotersNames.join(', ')}\n\n`;
            } else {
                responseText += `✅ *All users have voted!*\n\n`;
            }
            index++;
        }

        responseText += `🔥 *Vote now! Do not miss out:*\n🔗 ${WEB_URL}/vote.php\n`;

        if (totalMentions.length > 0) {
            responseText += `\n🔔 *Reminders sent to:* `;
            const tagStrings = totalMentions.map(jid => {
                const pureMobile = jid.split('@')[0];
                return `@${pureMobile}`;
            });
            responseText += tagStrings.join(' ');
        }

        await sock.sendMessage(from, { 
            text: responseText, 
            mentions: totalMentions 
        });

    } catch (error) {
        console.error('Error handling !poll command:', error);
        await sock.sendMessage(from, { text: "⚠️ Error gathering poll data." });
    }
}

async function handleRankCommand(sock, from, waNumber) {
    try {
        const data = await getLeaderboardFromServer();
        if (!data || data.length === 0) return await sock.sendMessage(from, { text: `📊 No points recorded yet!\n\nStart voting by typing: !vote` });

        let response = '🏆 *Rankings*\n\n';
        data.forEach((user, index) => {
            const name = user.name || user.wa_number || 'Anonymous';
            const isYou = user.wa_number === waNumber ? ' 👈' : '';
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            response += `${medal} ${name}: ${user.total_points || 0} pts${isYou}\n   📊 ${user.correct_predictions || 0}/${user.total_predictions || 0} correct\n`;
        });
        response += `\n📱 Full rankings: ${WEB_URL}/leaderboard.php`;
        await sock.sendMessage(from, { text: response });
    } catch (error) {
        console.error(error);
        await sock.sendMessage(from, { text: '⚠️ Error fetching rankings. Please try again.' });
    }
}

async function handlePointsCommand(sock, from, waNumber) {
    try {
        const user = await getUserStatsFromServer(waNumber);
        if (!user) return await sock.sendMessage(from, { text: `📊 No stats found. Start voting with !vote` });

        const accuracy = user.total_predictions > 0 ? 
            Math.round((user.correct_predictions / user.total_predictions) * 100) : 0;

        const displayName = user.name || user.wa_number || 'You';

        let responseText = `📊 *${displayName}'s Stats*\n\n` +
            `⭐ Points: ${user.total_points || 0}\n` +
            `✅ Correct: ${user.correct_predictions || 0}\n` +
            `📊 Total predictions: ${user.total_predictions || 0}\n` +
            `🎯 Accuracy: ${accuracy}%\n\n` +
            `📱 Full rankings: ${WEB_URL}/leaderboard.php`;
        
        await sock.sendMessage(from, { text: responseText });
    } catch (error) {
        console.error(error);
        await sock.sendMessage(from, { text: '⚠️ Error fetching your stats. Please try again.' });
    }
}

async function handleScheduleCommand(sock, from) {
    try {
        const matches = await getMatchesFromActivePolls();
        
        if (!matches || matches.length === 0) {
            return await sock.sendMessage(from, { text: '📅 No matches available in current polls.' });
        }

        const today = new Date().toDateString();
        const todayMatches = matches.filter(m => {
            const matchDate = new Date(m.kickoff).toDateString();
            return matchDate === today;
        });

        if (todayMatches.length === 0) {
            return await sock.sendMessage(from, { text: '📅 No matches scheduled for today in current polls.' });
        }

        let message = '📅 *Today\'s Poll Matches*\n\n';
        todayMatches.forEach(m => {
            const time = formatTime(m.kickoff);
            const status = m.status === 'completed' ? '✅' : '⏳';
            message += `${status} ${m.team1} vs ${m.team2}\n`;
            message += `⏰ ${time}\n\n`;
        });

        message += `📊 Vote now: ${WEB_URL}/vote.php`;
        await sock.sendMessage(from, { text: message });
    } catch (error) {
        console.error(error);
        await sock.sendMessage(from, { text: '⚠️ Error fetching schedule. Please try again.' });
    }
}

async function handleResultsCommand(sock, from) {
    try {
        const matches = await getMatchesFromActivePolls();
        
        if (!matches || matches.length === 0) {
            return await sock.sendMessage(from, { text: '📋 No matches in current polls.' });
        }

        const completed = matches.filter(m => m.status === 'completed');
        
        if (completed.length === 0) {
            return await sock.sendMessage(from, { text: '📋 No completed matches in current polls yet.' });
        }

        let responseText = '📋 *Match Results (Current Polls)*\n\n';
        completed.slice(-5).reverse().forEach(m => {
            const winner = m.winner || 'Draw';
            const score = m.score || `${m.home_score || 0}-${m.away_score || 0}`;
            responseText += `⚽ ${m.team1} vs ${m.team2}\n`;
            responseText += `📊 Result: ${score} (${winner})\n\n`;
        });
        
        responseText += `📱 Full results: ${WEB_URL}/matches.php`;
        await sock.sendMessage(from, { text: responseText });
    } catch (error) {
        console.error(error);
        await sock.sendMessage(from, { text: '⚠️ Error fetching results. Please try again.' });
    }
}

async function handleStatsCommand(sock, from, waNumber) {
    try {
        const user = await getUserStatsFromServer(waNumber);
        if (!user) return await sock.sendMessage(from, { text: `📊 No stats found. Get voting via !vote` });

        const accuracy = user.total_predictions > 0 ? 
            Math.round((user.correct_predictions / user.total_predictions) * 100) : 0;

        const displayName = user.name || user.wa_number || 'You';

        let responseText = `📊 *${displayName}'s Stats*\n\n` +
            `👤 Name: ${displayName}\n` +
            `⭐ Points: ${user.total_points || 0}\n` +
            `✅ Correct: ${user.correct_predictions || 0}/${user.total_predictions || 0}\n` +
            `🎯 Accuracy: ${accuracy}%`;
        
        await sock.sendMessage(from, { text: responseText });
    } catch (error) {
        console.error(error);
        await sock.sendMessage(from, { text: '⚠️ Error fetching your stats. Please try again.' });
    }
}

async function handleStatusCommand(sock, from) {
    try {
        const groupIds = await getGroupIds();
        const activeMatches = await getActiveMatchCount();
        const pollMatchIds = await getPollMatchIds();
        
        const status = `🤖 *Bot Status*\n\n` +
            `✅ Connected: ${sock ? 'Yes' : 'No'}\n` +
            `⏰ Uptime: ${Math.floor(process.uptime() / 60)} minutes\n` +
            `👥 Groups: ${groupIds.length}\n` +
            `📊 Active matches: ${activeMatches}\n` +
            `📊 Cached matches: ${matchesCache.length}\n` +
            `📊 Poll matches: ${pollMatchIds.length}\n` +
            `⏰ Daily reminder: 11:00 AM UAE time\n` +
            `⏰ Match reminders: 1 hour before kickoff (every 10 min)\n` +
            `🏆 Points announcements: Every 10 min\n` +
            `📅 Last reminder sent: ${lastReminderDate || 'Never'}\n\n` +
            `📱 ${WEB_URL}`;
        
        await sock.sendMessage(from, { text: status });
    } catch (error) {
        console.error(error);
        await sock.sendMessage(from, { text: '⚠️ Error fetching status.' });
    }
}

async function handleHelpCommand(sock, from) {
    const response = `📋 *Available Commands*\n\n` +
        `🗳️ *!vote* - Get your voting link\n` +
        `📊 *!poll* - View current poll status\n` +
        `🏆 *!rank* - Top rankings\n` +
        `👤 *!points* - Your points & stats\n` +
        `📅 *!schedule* - Today's matches\n` +
        `📋 *!results* - Match results\n` +
        `📊 *!stats* - Your detailed stats\n` +
        `🤖 *!status* - Bot health\n` +
        `ℹ️ *!help* - This menu\n\n` +
        `⚽ *World Cup 2026*\n` +
        `📱 ${WEB_URL}`;
    
    await sock.sendMessage(from, { text: response });
}

// ==================== START SERVER & BOT ====================
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Bot will send daily reminder at 11:00 AM UAE time (ONCE per day)`);
    console.log(`⏰ Match reminders: 1 hour before kickoff (every 10 minutes)`);
    console.log(`🏆 Points announcements: Every 10 minutes`);
    console.log(`📊 Cache TTL: 30 minutes`);
    connectToWhatsApp();
});