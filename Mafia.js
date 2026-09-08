import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import http from 'http';

// Kutilmagan xatoliklar tufayli bot to'xtab qolmasligi uchun
process.on('uncaughtException', (err) => {
  console.error('Kutilmagan xatolik ushlandi:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Inkor etilmagan promise xatoligi:', reason);
});

process.env.NTBA_FIX_350 = '1';

const token = process.env.BOT_TOKEN || '8945348177:AAFjOm-MEUAXXtaV6qR79Mo_ctvOgx4Qlkg';
const bot = new TelegramBot(token, { polling: true });

const DATA_FILE = path.resolve('./stats.json');

function loadStats() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify({}), 'utf8');
      return {};
    }
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(data || '{}');
  } catch (err) {
    console.error("Fayl o'qishda xatolik:", err.message);
    return {};
  }
}

function saveStats(stats) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(stats, null, 2), 'utf8');
  } catch (err) {
    console.error("Faylga yozishda xatolik:", err.message);
  }
}

let players = [];
let isGameStarted = false;
let gamePhase = 'WAITING'; 

let roles = {}; 
let nightActions = { mafiaKill: null, doctorHeal: null, detectiveCheck: null };
let dayVotes = {}; 

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  if (msg.chat.type === 'private') {
    return bot.sendMessage(
      chatId,
      "🕵️‍♂️ *Mafiya Botiga xush kelibsiz!*\n\nMeni guruhga qo'shing va o'yinni boshlash uchun guruhda `/start` bosing.",
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  if (isGameStarted) {
    return bot.sendMessage(chatId, "⚠️ O'yin allaqachon boshlangan!").catch(() => {});
  }

  players = [];
  roles = {};
  nightActions = { mafiaKill: null, doctorHeal: null, detectiveCheck: null };
  dayVotes = {};
  gamePhase = 'WAITING';

  const lobbyText = getLobbyText();
  try {
    await bot.sendMessage(chatId, lobbyText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✋ Qo'shilish", callback_data: "join_game" },
            { text: "🚪 Tark etish", callback_data: "leave_game" }
          ],
          [
            { text: "🚀 O'yinni boshlash (min 2)", callback_data: "force_start" }
          ],
          [
            { text: "🏆 TOP G'oliblar", callback_data: "show_top" }
          ]
        ]
      }
    });
  } catch (err) {
    console.error("Lobby xabarini yuborishda xatolik:", err.message);
  }
});

bot.onText(/\/top/, (msg) => {
  sendTopWinners(msg.chat.id);
});

function sendTopWinners(chatId) {
  const stats = loadStats();
  const sorted = Object.values(stats).sort((a, b) => b.wins - a.wins).slice(0, 10);

  if (sorted.length === 0) {
    return bot.sendMessage(chatId, "🏆 *TOP G'OLIBLAR JADVALI*\n\nHozircha g'oliblar mavjud emas.", { parse_mode: 'Markdown' }).catch(() => {});
  }

  let topText = "🏆 *TOP G'OLIBLAR JADVALI*\n\n";
  sorted.forEach((u, idx) => {
    const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "👤";
    topText += `${medal} ${idx + 1}. *${u.name}* (@${u.username || 'user'}) — *${u.wins} ta g'alaba* (${u.games} ta o'yinda)\n`;
  });

  bot.sendMessage(chatId, topText, { parse_mode: 'Markdown' }).catch(err => console.error(err.message));
}

function getLobbyText() {
  let text = `🕵️‍♂️ *MAFIA O'YINI RO'YXATI* (${players.length}/10)\n\n`;
  if (players.length === 0) {
    text += "Hozircha hech kim qo'shilmadi.\n";
  } else {
    players.forEach((p, idx) => {
      text += `${idx + 1}. *${p.name}* (@${p.username || 'user'})\n`;
    });
  }
  text += `\n📌 O'yin boshlanishi uchun kamida *2 kishi* kerak (maksimal *10 kishi*).`;
  return text;
}

function assignRoles() {
  const count = players.length;
  let baseRoles = ["Mafia", "Citizen"];

  if (count >= 3) baseRoles.push("Doctor");
  if (count >= 4) baseRoles.push("Detective");
  if (count >= 7) baseRoles.push("Mafia");
  if (count >= 9) baseRoles.push("Don");

  while (baseRoles.length < count) {
    baseRoles.push("Citizen");
  }

  const shuffled = baseRoles.sort(() => Math.random() - 0.5);

  players.forEach((p, idx) => {
    roles[p.id] = {
      role: shuffled[idx],
      isAlive: true,
      name: p.name,
      username: p.username
    };
  });
}

async function startNightPhase(chatId) {
  gamePhase = 'NIGHT';
  nightActions = { mafiaKill: null, doctorHeal: null, detectiveCheck: null };

  await bot.sendMessage(
    chatId,
    "🌃 *TUN TUSHDI... SHAHAR UXLAMOQDA.*\n\n" +
    "Barcha o'yinchilarning shaxsiy xabarlariga (DM) maxfiy buyruqlar yuborildi.",
    { parse_mode: 'Markdown' }
  ).catch(e => console.error(e.message));

  const alivePlayers = players.filter(p => roles[p.id].isAlive);

  for (const p of alivePlayers) {
    const userRole = roles[p.id].role;
    const targetButtons = alivePlayers
      .filter(target => target.id !== p.id)
      .map(target => [{ text: target.name, callback_data: `night_${userRole}_${target.id}` }]);

    let roleMsg = "";
    if (userRole === "Mafia" || userRole === "Don") roleMsg = "🔪 Siz *MAFIYA*siz. Tunda kimni o'ldirmoqchisiz?";
    else if (userRole === "Doctor") roleMsg = "💉 Siz *SHIFOKOR*siz. Kimni qutqarmoqchisiz?";
    else if (userRole === "Detective") roleMsg = "🔍 Siz *KOMISSAR*siz. Kimni tekshirmoqchisiz?";
    else roleMsg = "😴 Siz *TINCH FUQARO*siz. Tun tugashini kuting...";

    try {
      if (userRole !== "Citizen") {
        await bot.sendMessage(p.id, roleMsg, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: targetButtons }
        });
      } else {
        await bot.sendMessage(p.id, roleMsg, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      bot.sendMessage(chatId, `⚠️ *${p.name}* botga shaxsiyda /start bosmagan!`, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }
}

async function checkNightPhaseComplete(chatId) {
  const aliveMafia = players.some(p => roles[p.id].isAlive && (roles[p.id].role === 'Mafia' || roles[p.id].role === 'Don'));
  const aliveDoctor = players.some(p => roles[p.id].isAlive && roles[p.id].role === 'Doctor');
  const aliveDetective = players.some(p => roles[p.id].isAlive && roles[p.id].role === 'Detective');

  const mafiaDone = !aliveMafia || nightActions.mafiaKill !== null;
  const doctorDone = !aliveDoctor || nightActions.doctorHeal !== null;
  const detectiveDone = !aliveDetective || nightActions.detectiveCheck !== null;

  if (mafiaDone && doctorDone && detectiveDone) {
    await processNightResults(chatId);
  }
}

async function processNightResults(chatId) {
  let killedUser = null;

  if (nightActions.mafiaKill && nightActions.mafiaKill !== nightActions.doctorHeal) {
    killedUser = nightActions.mafiaKill;
    roles[killedUser].isAlive = false;
  }

  let resultMsg = "☀️ *KUN BOTDI! SHAHAR UYG'ONDI.*\n\n";

  if (killedUser) {
    resultMsg += `☠️ Tunda Mafiya *${roles[killedUser].name}*ni o'ldirdi! U o'yindan chiqdi.\n`;
  } else {
    resultMsg += "🛡 Shifokor a'lo darajada ishladi! Tunda hech kim halok bo'lmadi.\n";
  }

  await bot.sendMessage(chatId, resultMsg, { parse_mode: 'Markdown' }).catch(e => console.error(e.message));

  if (checkWinner(chatId)) return;

  await startDayVoting(chatId);
}

async function startDayVoting(chatId) {
  gamePhase = 'DAY_VOTING';
  dayVotes = {};

  const alivePlayers = players.filter(p => roles[p.id].isAlive);
  const voteButtons = alivePlayers.map(p => [
    { text: `🗳 ${p.name}`, callback_data: `vote_${p.id}` }
  ]);

  await bot.sendMessage(
    chatId,
    "🗣 *OVOZ BERISH BOSHLANDI!*\n\nSizningcha, kim Mafiya? Tanlang:",
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: voteButtons }
    }
  ).catch(e => console.error(e.message));
}

function checkWinner(chatId) {
  const alivePlayers = players.filter(p => roles[p.id].isAlive);
  const aliveMafia = alivePlayers.filter(p => roles[p.id].role === 'Mafia' || roles[p.id].role === 'Don');
  const aliveCitizens = alivePlayers.filter(p => roles[p.id].role !== 'Mafia' && roles[p.id].role !== 'Don');

  if (aliveMafia.length === 0) {
    finishGame(chatId, "🎉 *TINCH FUQAROLAR G'OLIB BO'LDI!*", "Citizens");
    return true;
  } else if (aliveMafia.length >= aliveCitizens.length) {
    finishGame(chatId, "🗡 *MAFIYA G'OLIB BO'LDI! Shahar egallandi.*", "Mafia");
    return true;
  }
  return false;
}

function finishGame(chatId, winnerAnnouncement, winningTeam) {
  isGameStarted = false;
  gamePhase = 'WAITING';

  const stats = loadStats();

  let summary = `${winnerAnnouncement}\n\n📋 *Barcha o'yinchilar va ularning rollari:*\n`;
  players.forEach((p, idx) => {
    const r = roles[p.id];
    summary += `${idx + 1}. *${p.name}* (@${p.username || 'user'}) — *${r.role}* ${r.isAlive ? "🟢 (Tirik)" : "🔴 (O'lgan)"}\n`;

    if (!stats[p.id]) {
      stats[p.id] = { name: p.name, username: p.username, wins: 0, games: 0 };
    }

    stats[p.id].games += 1;
    stats[p.id].name = p.name;
    stats[p.id].username = p.username;

    const isMafiaRole = r.role === 'Mafia' || r.role === 'Don';
    if ((winningTeam === "Mafia" && isMafiaRole) || (winningTeam === "Citizens" && !isMafiaRole)) {
      stats[p.id].wins += 1;
    }
  });

  saveStats(stats);
  bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' }).catch(e => console.error(e.message));
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;
  const userName = query.from.first_name;
  const data = query.data;

  try {
    if (data === 'show_top') {
      sendTopWinners(chatId);
      return await bot.answerCallbackQuery(query.id).catch(() => {});
    }

    if (data === 'join_game') {
      if (isGameStarted) {
        return await bot.answerCallbackQuery(query.id, { text: "O'yin boshlanib bo'ldi!", show_alert: true }).catch(() => {});
      }

      const isAlreadyJoined = players.some(p => String(p.id) === String(userId));
      if (isAlreadyJoined) {
        return await bot.answerCallbackQuery(query.id, { text: "Siz allaqachon ro'yxatdasiz!", show_alert: true }).catch(() => {});
      }

      if (players.length >= 10) {
        return await bot.answerCallbackQuery(query.id, { text: "Xona to'ldi! Maksimal 10 kishi.", show_alert: true }).catch(() => {});
      }

      players.push({ id: userId, name: userName, username: query.from.username });
      await bot.answerCallbackQuery(query.id, { text: "✅ Ro'yxatga qo'shildingiz!" }).catch(() => {});

      // Guruhga xabar yuborish
      await bot.sendMessage(chatId, `👤 *${userName}* o'yinga qo'shildi! (Jami: ${players.length} ta)`, { parse_mode: 'Markdown' }).catch(() => {});

      const updatedText = getLobbyText();
      await bot.editMessageText(updatedText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✋ Qo'shilish", callback_data: "join_game" },
              { text: "🚪 Tark etish", callback_data: "leave_game" }
            ],
            [
              { text: "🚀 O'yinni boshlash (min 2)", callback_data: "force_start" }
            ],
            [
              { text: "🏆 TOP G'oliblar", callback_data: "show_top" }
            ]
          ]
        }
      }).catch(err => console.error("Xabarni tahrirlashda xatolik:", err.message));

      if (players.length === 10) {
        isGameStarted = true;
        assignRoles();
        await bot.sendMessage(chatId, "🔥 10 ta o'yinchi yig'ildi! O'yin boshlandi.").catch(() => {});
        await startNightPhase(chatId);
      }
    }

    if (data === 'leave_game') {
      const exists = players.some(p => String(p.id) === String(userId));
      if (!exists) {
        return await bot.answerCallbackQuery(query.id, { text: "Siz ro'yxatda yo'qsiz!", show_alert: true }).catch(() => {});
      }

      players = players.filter(p => String(p.id) !== String(userId));
      await bot.answerCallbackQuery(query.id, { text: "Ro'yxatdan chiqdingiz." }).catch(() => {});

      await bot.sendMessage(chatId, `🚪 *${userName}* o'yinni tark etdi! (Qoldi: ${players.length} ta)`, { parse_mode: 'Markdown' }).catch(() => {});

      const updatedText = getLobbyText();
      await bot.editMessageText(updatedText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✋ Qo'shilish", callback_data: "join_game" },
              { text: "🚪 Tark etish", callback_data: "leave_game" }
            ],
            [
              { text: "🚀 O'yinni boshlash (min 2)", callback_data: "force_start" }
            ],
            [
              { text: "🏆 TOP G'oliblar", callback_data: "show_top" }
            ]
          ]
        }
      }).catch(err => console.error(err.message));
    }

    if (data === 'force_start') {
      if (players.length < 2) {
        return await bot.answerCallbackQuery(query.id, { text: `Kamida 2 kishi kerak! Hozir: ${players.length} ta`, show_alert: true }).catch(() => {});
      }
      if (isGameStarted) return;

      isGameStarted = true;
      assignRoles();
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.sendMessage(chatId, "🚀 O'yin boshlandi!").catch(() => {});
      await startNightPhase(chatId);
    }

    if (data.startsWith('night_')) {
      const parts = data.split('_');
      const actionRole = parts[1];
      const targetId = parseInt(parts[2]);

      if (actionRole === 'Mafia' || actionRole === 'Don') nightActions.mafiaKill = targetId;
      if (actionRole === 'Doctor') nightActions.doctorHeal = targetId;
      if (actionRole === 'Detective') {
        nightActions.detectiveCheck = targetId;
        const isMaf = roles[targetId].role === 'Mafia' || roles[targetId].role === 'Don';
        await bot.sendMessage(userId, `🔍 Natija: *${roles[targetId].name}* — ${isMaf ? "🗡 MAFIYA!" : "😇 Tinch fuqaro."}`, { parse_mode: 'Markdown' }).catch(() => {});
      }

      await bot.answerCallbackQuery(query.id, { text: "Tanlov saqlandi!" }).catch(() => {});
      await bot.sendMessage(userId, "✅ Tanlovingiz saqlandi.").catch(() => {});

      checkNightPhaseComplete(chatId);
    }

    if (data.startsWith('vote_')) {
      if (gamePhase !== 'DAY_VOTING') return await bot.answerCallbackQuery(query.id, { text: "Hozir ovoz berish vaqti emas!", show_alert: true }).catch(() => {});
      if (!roles[userId] || !roles[userId].isAlive) return await bot.answerCallbackQuery(query.id, { text: "Faqat tiriklar ovoz berishi mumkin!", show_alert: true }).catch(() => {});

      const targetId = parseInt(data.split('_')[1]);
      dayVotes[targetId] = (dayVotes[targetId] || 0) + 1;

      await bot.answerCallbackQuery(query.id, { text: "Ovozingiz saqlandi!" }).catch(() => {});

      const aliveCount = players.filter(p => roles[p.id].isAlive).length;
      const totalVotes = Object.values(dayVotes).reduce((a, b) => a + b, 0);

      if (totalVotes >= aliveCount) {
        let maxVotes = 0;
        let executedUser = null;

        for (const [id, count] of Object.entries(dayVotes)) {
          if (count > maxVotes) {
            maxVotes = count;
            executedUser = parseInt(id);
          }
        }

        if (executedUser) {
          roles[executedUser].isAlive = false;
          await bot.sendMessage(
            chatId,
            `⚖️ *OVOZ BERISH YAKUNLANDI!*\n\n` +
            `A'zolar qaroriga ko'ra *${roles[executedUser].name}* qatl qilindi!\n` +
            `Uning roli: *${roles[executedUser].role}* edi.`,
            { parse_mode: 'Markdown' }
          ).catch(e => console.error(e.message));
        }

        if (!checkWinner(chatId)) {
          await startNightPhase(chatId);
        }
      }
    }
  } catch (err) {
    console.error("Callback asosiy xatoligi:", err.message);
  }
});

bot.on('polling_error', (err) => console.error("Polling error:", err.code || err.message));

// Render.com uchun HTTP port va har 5 daqiqada avto-ping
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.RENDER_EXTERNAL_URL;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Mafia Bot Active\n');
}).listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  
  setInterval(() => {
    if (SERVER_URL) {
      http.get(SERVER_URL, (res) => {
        console.log(`Auto-ping status: ${res.statusCode}`);
      }).on('error', (err) => {
        console.error('Auto-ping error:', err.message);
      });
    }
  }, 5 * 60 * 1000);
});

console.log("Mafia bot to'liq ishga tushdi!");
