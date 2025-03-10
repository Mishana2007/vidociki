require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const app = express();
const PORT = 3000;

const CHANNEL_USERNAME = '@lfdlfmldf';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DAILY_LIMIT = 1;
const INITIAL_LIMIT = 3;
const BOT_USERNAME = '@TalksAI_bot';

const db = new sqlite3.Database('bot_database.db');
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      remaining_processes INTEGER DEFAULT ${INITIAL_LIMIT},
      last_reset_date TEXT,
      registration_date TEXT DEFAULT CURRENT_TIMESTAMP,
      referral_code TEXT UNIQUE,
      referred_by TEXT
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS referral_uses (
      referral_code TEXT,
      used_by INTEGER,
      used_date TEXT,
      UNIQUE(referral_code, used_by)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      payment_id TEXT PRIMARY KEY,
      user_id INTEGER,
      package_type TEXT,
      amount INTEGER,
      status TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GENAI);

function getTimeUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const diff = midnight - now;
  return {
    hours: Math.floor(diff / (1000 * 60 * 60)),
    minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  };
}

function generateReferralCode(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

const MESSAGES = {
  welcome: (remaining) => {
    const time = getTimeUntilMidnight();
    return `
🎥 *Добро пожаловать в Video Analysis Bot!*

Я помогу вам проанализировать ваши видео и предоставить профессиональный разбор.

📌 *Как использовать бот:*
1. Подпишитесь на наш канал
2. Отправьте видео для анализа
3. Получите детальный разбор

⚡️ *Система анализов:*
• ${INITIAL_LIMIT} анализа после регистрации
• +${DAILY_LIMIT} анализ каждый день
• Дополнительные анализы за приглашения

🎯 *Доступно анализов:* ${remaining}
⏰ *Следующее обновление через:* ${time.hours}ч ${time.minutes}м

💫 Используйте /ref для получения реферальной ссылки`;
  },

  subscribe: `
❗️ *Необходима подписка*

Для использования бота:
1️⃣ Подпишитесь на канал ${CHANNEL_USERNAME}
2️⃣ Отправьте любое видео для анализа
3️⃣ Получите профессиональный разбор`,

  processing: `
🔄 *Начинаю анализ вашего видео*

⏳ Это займет несколько минут
📝 Вы получите подробный разбор всех аспектов выступления`,

  complete: `
✅ *Анализ выступления завершен*

📊 Результаты анализа представлены ниже`,

  error: `
❌ *Не удалось обработать видео*

Возможные причины:
• Формат файла не поддерживается
• Размер превышает 20MB
• Технические неполадки`,

  limitReached: (time) => `
⚠️ *Лимит исчерпан*

• Доступные анализы закончились
• +${DAILY_LIMIT} анализ завтра
• До обновления: ${time.hours}ч ${time.minutes}м

💡 Получите больше анализов:
• Пригласите друзей через /ref
• Дождитесь ежедневного обновления`,

  referral: (code) => `
🎁 *Ваша реферальная ссылка:*

https://t.me/${BOT_USERNAME}?start=${code}

За каждого приглашенного пользователя вы получите:
• +2 дополнительных анализа
• Возможность копить анализы

🔄 Ссылка многоразовая`
};

async function getReferralCode(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT referral_code FROM users WHERE user_id = ?', [userId], async (err, user) => {
      if (err) return reject(err);
      
      if (user?.referral_code) {
        resolve(user.referral_code);
      } else {
        const code = generateReferralCode();
        db.run('UPDATE users SET referral_code = ? WHERE user_id = ?', [code, userId], (err) => {
          if (err) reject(err);
          else resolve(code);
        });
      }
    });
  });
}

async function addReferralBonus(userId) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET remaining_processes = remaining_processes + 2 WHERE user_id = ?',
      [userId],
      err => err ? reject(err) : resolve()
    );
  });
}

async function processReferral(userId, referralCode) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT user_id FROM users WHERE referral_code = ?',
      [referralCode],
      async (err, referrer) => {
        if (err) return reject(err);
        if (!referrer) return resolve(false);

        try {
          await db.run(
            'INSERT INTO referral_uses (referral_code, used_by, used_date) VALUES (?, ?, ?)',
            [referralCode, userId, new Date().toISOString()]
          );
          await addReferralBonus(referrer.user_id);
          await db.run(
            'UPDATE users SET referred_by = ? WHERE user_id = ?',
            [referralCode, userId]
          );
          resolve(true);
        } catch (err) {
          resolve(false);
        }
      }
    );
  });
}

async function processVideo(videoPath, prompt) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const videoData = fs.readFileSync(videoPath);
    const base64Video = videoData.toString('base64');

    const parts = [{
      inlineData: {
        data: base64Video,
        mimeType: 'video/mp4'
      }
    }, prompt];

    const result = await model.generateContent(parts);
    return result.response.text();
  } catch (error) {
    console.error('Video processing error:', error);
    throw error;
  }
}

async function isSubscribed(chatId) {
  try {
    const member = await bot.getChatMember(CHANNEL_USERNAME, chatId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch {
    return false;
  }
}

async function checkProcessingLimit(userId) {
  return new Promise((resolve, reject) => {
    const currentDate = new Date().toISOString().split('T')[0];
    db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, user) => {
      if (err) return reject(err);
      
      if (!user) {
        db.run('INSERT INTO users (user_id, remaining_processes, last_reset_date) VALUES (?, ?, ?)',
          [userId, INITIAL_LIMIT, currentDate]);
        resolve({ canProcess: true, remaining: INITIAL_LIMIT });
      } else if (user.last_reset_date !== currentDate) {
        db.run('UPDATE users SET remaining_processes = ?, last_reset_date = ? WHERE user_id = ?',
          [DAILY_LIMIT, currentDate, userId]);
        resolve({ canProcess: true, remaining: DAILY_LIMIT });
      } else {
        resolve({ 
          canProcess: user.remaining_processes > 0,
          remaining: user.remaining_processes
        });
      }
    });
  });
}

async function decreaseProcessingCount(userId) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET remaining_processes = remaining_processes - 1 WHERE user_id = ?',
      [userId], err => err ? reject(err) : resolve());
  });
}

async function sendLongMessage(chatId, text) {
  const maxLength = 4096;
  const parts = [];
  let message = text;

  while (message.length > 0) {
    if (message.length > maxLength) {
      let part = message.substr(0, maxLength);
      const lastNewline = part.lastIndexOf('\n');
      
      if (lastNewline !== -1) {
        part = message.substr(0, lastNewline);
        message = message.substr(lastNewline + 1);
      } else {
        message = message.substr(maxLength);
      }
      parts.push(part);
    } else {
      parts.push(message);
      message = '';
    }
  }

  for (const part of parts) {
    await bot.sendMessage(chatId, part);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

bot.onText(/\/start (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const referralCode = match[1];

  const subscribed = await isSubscribed(chatId);
  if (!subscribed) {
    await bot.sendMessage(chatId, MESSAGES.subscribe, { parse_mode: 'Markdown' });
    return;
  }

  await processReferral(chatId, referralCode);
  const limits = await checkProcessingLimit(chatId);
  await bot.sendMessage(
    chatId,
    MESSAGES.welcome(limits.remaining),
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  
  const subscribed = await isSubscribed(chatId);
  if (!subscribed) {
    await bot.sendMessage(chatId, MESSAGES.subscribe, { parse_mode: 'Markdown' });
    return;
  }

  const limits = await checkProcessingLimit(chatId);
  await bot.sendMessage(
    chatId,
    MESSAGES.welcome(limits.remaining),
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/ref/, async (msg) => {
  const chatId = msg.chat.id;
  
  const subscribed = await isSubscribed(chatId);
  if (!subscribed) {
    await bot.sendMessage(chatId, MESSAGES.subscribe, { parse_mode: 'Markdown' });
    return;
  }

  const referralCode = await getReferralCode(chatId);
  await bot.sendMessage(
    chatId,
    MESSAGES.referral(referralCode),
    { parse_mode: 'Markdown' }
  );
});

bot.on('video', async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    const subscribed = await isSubscribed(chatId);
    if (!subscribed) {
      await bot.sendMessage(chatId, MESSAGES.subscribe, { parse_mode: 'Markdown' });
      return;
    }

    const limits = await checkProcessingLimit(chatId);
    if (!limits.canProcess) {
      const time = getTimeUntilMidnight();
      await bot.sendMessage(
        chatId,
        MESSAGES.limitReached(time),
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Отправляем кнопки с выбором промта
    const keyboard = {
      inline_keyboard: [
        [{ text: 'Анализ выступления спикера', callback_data: 'gestures_and_facial_expressions' }],
        [{ text: 'Анализ монтажа видео', callback_data: 'speech_and_voice' }],
        [{ text: 'анализ содержимого в видео ролике', callback_data: 'general_analysis' }]
      ]
    };

    await bot.sendMessage(chatId, 'Выберите тип анализа:', {
      reply_markup: keyboard
    });

    // Сохраняем file_id видео для последующей обработки
    const fileId = msg.video.file_id;
    bot.once('callback_query', async (query) => {
      const chatId = query.message.chat.id;
      const data = query.data;

      let prompt;
      switch (data) {
        case 'gestures_and_facial_expressions':
          prompt = `
📊 АНАЛИЗ ВИДЕОВЫСТУПЛЕНИЯ

1️⃣ НЕВЕРБАЛЬНАЯ КОММУНИКАЦИЯ
• Жесты и движения
• Поза и осанка
• Мимика и эмоции
• Зрительный контакт
• Использование пространства

2️⃣ РЕЧЬ И ГОЛОС
• Темп и ритм
• Громкость и интонация
• Чёткость произношения
• Паузы и акценты
• Эмоциональный окрас

3️⃣ СТРУКТУРА
• Логика изложения
• Связность мыслей
• Ключевые моменты
• Работа с аудиторией

4️⃣ ОБЩАЯ ОЦЕНКА
• Сильные стороны
• Области для улучшения
• Рейтинг по 10-балльной шкале

5️⃣ РЕКОМЕНДАЦИИ
• 3-5 конкретных советов
• Практические упражнения
• Следующие шаги`;
          break;
        case 'speech_and_voice':
          prompt = `
. Deep Content Analysis:

Topic and Niche:
  •  Uniqueness: Does the topic bring something new or unusual? Or is it an original take on a familiar subject?
  •  Niche Appeal: How broad or narrow is the target audience for this topic? Narrower niches often attract a more loyal and engaged audience.
  •  Discussion Potential: Does the topic spark debates, discussions, or a desire to share opinions?

Structure and Narrative:
  •  Attention Grab: How quickly does the video hook the viewer? Are intriguing questions, unexpected twists, or striking visuals used in the first few seconds? The first 3-5 seconds are critical.
  •  Retention: How does the video maintain interest throughout its duration? Is there dynamic pacing, shot variation, and diverse content?
  •  Climax and Resolution: Does the video build up to a strong emotional climax? How does it end – with a call to action, an open-ended question, or a surprising finale?
  •  Clarity: How easy is it for the viewer to understand the core message? Does the video avoid complex terminology and confusing explanations?
  •  Storytelling: Does the video tell a story? Stories are more memorable and create stronger emotional connections.

Emotional Impact:
  •  Type of Emotion: What emotions does the video evoke – laughter, surprise, sadness, joy, anger, inspiration? Strong emotions (of any kind) increase shareability.
  •  Intensity: How powerful are these emotions? Weak emotional responses rarely lead to virality.
  •  Universality: Are these emotions relatable to a broad audience, regardless of age, gender, or cultural background?
  •  Social Relevance: Does the video address important social topics, values, or issues?

Content Quality:
  •  Informative Value: Does the video provide useful, interesting, or new information?
  •  Credibility: Does the information appear trustworthy? Are sources or expert opinions referenced?
  •  Originality: Is the content unique, or is it a rehash of existing material?
  •  Visual Appeal: How aesthetically pleasing is the video? (See technical aspects for more details.)

II. Technical Aspects:

Video Quality:
  •  Resolution: High resolution (at least 1080p, preferably 4K) is the standard for modern social media.
  •  Stabilization: Smooth footage without excessive shakiness.
  •  Lighting: Well-lit subjects with no overexposure or harsh shadows.
  •  Color Grading: Natural and visually pleasing colors.

Audio Quality:
  •  Clarity: No background noise or echo.
  •  Volume: Balanced audio levels, ensuring clarity without being overwhelming.
  •  Music: Suitable background music that enhances the mood without overpowering dialogue.

Editing:
  •  Dynamics: Frequent cuts and engaging transitions to maintain attention.
  •  Pacing: Editing speed that matches the energy and tone of the content.
  •  Visual Effects: Moderate and appropriate effects that do not distract from the main message.
  •  Subtitles & Graphics: Readable text, clean design, and stylistic consistency.

Format:
  •  Aspect Ratio: Vertical (9:16) for TikTok, Reels, Shorts; square (1:1) or horizontal (16:9) for other platforms.
  •  Duration: The optimal length depends on the platform. Short videos (under 1 minute) are more likely to be watched in full.

III. Trend and Platform Analysis:

Current Trends:
  •  What topics, formats, challenges, and music are currently trending on a given platform?
  •  What hashtags are widely used?
  •  Which bloggers and influencers are setting trends?

Platform Algorithms:
  •  What factors influence content promotion (engagement, watch time, comments, shares, likes)?
  •  How frequently should content be posted?
  •  What is the best time to publish content?

Platform Audience:
  •  Who are the main users (age, gender, interests)?
  •  What type of content do they prefer?
  •  What are their expectations from the content?

V. Predicting Virality:
By analyzing all these factors, you can develop a hypothesis about a video’s viral potential. While there is no 100% guarantee, key elements that increase the chances include:

Strong emotional engagement + relevant topic + high production quality + alignment with trends + platform algorithm optimization = high chance of virality.

The response should always be in Russian.`;
          break;
        case 'general_analysis':
          prompt = `
## STEP 1: ANALYZING THE ORIGINAL VIDEO  
BREAK DOWN THE REELS INTO KEY PARAMETERS TO UNDERSTAND ITS STRUCTURE AND LOGIC.  

### WHAT TO ANALYZE?  
- BEGINNING OF THE VIDEO – HOW DOES IT IMMEDIATELY GRAB ATTENTION?  
- ENDING – HOW DOES THE VIDEO CONCLUDE, AND WHAT EFFECT DOES IT LEAVE?  
- PLOT – WHAT HAPPENS ON SCREEN? DESCRIBE THE MAIN DYNAMICS OF THE SCENE.  

### ADDITIONAL PARAMETERS:  
- BACKGROUND – LOCATION, ATMOSPHERE.  
- CHARACTERS – WHO IS ON SCREEN, THEIR POSTURE, FACIAL EXPRESSION, EMOTIONS.  
- TEXT – WHAT IS WRITTEN ON SCREEN, WHERE IT IS PLACED, WHAT STYLE IT USES.  
- CLOTHING – APPEARANCE OF THE CHARACTERS, DOES IT AFFECT THE MESSAGE?  
- CONTEXT – WHAT IDEA IS EMBEDDED, WHAT EMOTION DOES IT EVOKE?  
- PEOPLE / ROLES – HOW MANY CHARACTERS, WHAT ROLES DO THEY HAVE?  
- TYPE OF SHOOTING – STATIC CAMERA, DYNAMIC TRANSITIONS, CLOSE-UPS.  
- EDITING – SHARP CUTS, SMOOTH TRANSITIONS, EFFECTIVE INSERTS.  
- FORMAT AND PLATFORM – FOR WHICH SOCIAL MEDIA IS IT MADE (TIKTOK, REELS, SHORTS).  

### EXAMPLE ANALYSIS:  
ORIGINAL VIDEO:  
- BACKGROUND: PARTY, EVENING LIGHTING, DYNAMIC ATMOSPHERE.  
- CHARACTER: WOMAN IN A LUXURIOUS DRESS.  
- TEXT: "LET'S ADMIT IT ALREADY, A MAN'S BIGGEST FLEX IS HAVING A STUNNING WIFE BESIDE HIM."  
- EDITING: FAST-PACED CUTS, BRIGHT COLOR GRADING.  
- TONE: LIGHT SARCASM, STATUS EMPHASIS.  

---  

## STEP 2: CREATING A NEW SCRIPT WITH THE SAME MEANING BUT A DIFFERENT APPROACH  
TASK – COME UP WITH A UNIQUE VERSION OF THE VIDEO, PRESERVING ITS IDEA BUT COMPLETELY CHANGING THE CONTEXT, STYLE, AND PRESENTATION.  

### WHAT IS IMPORTANT IN THE NEW SCRIPT?  
 PRESERVING THE MAIN IDEA BUT THROUGH A DIFFERENT LIFE MOMENT.  
 CHANGING THE VISUAL STYLE – DIFFERENT BACKGROUND, CLOTHING, ANGLES, FILMING FORMAT.  
NEW CONTEXT – MAKING THE VIDEO RELEVANT TO A DIFFERENT AUDIENCE.  
ADAPTING TO THE PLATFORM – TAKING INTO ACCOUNT THE REQUIREMENTS OF TIKTOK, INSTAGRAM REELS, YOUTUBE SHORTS.  

### EXAMPLE OF A NEW SCRIPT:  
NEW VERSION:  
- BACKGROUND: KITCHEN IN THE MORNING, COZY HOME ATMOSPHERE.  
- CHARACTER: MAN IN A BATHROBE MAKING BREAKFAST.  
- TEXT: "A MAN'S BIGGEST FLEX IS WHEN HIS STUNNING WIFE IS STILL ASLEEP, AND HE’S ALREADY MAKING HER COFFEE."  
- EDITING: SLOW, WARM-TONED SHOTS.  
- TONE: WARMTH, CARE, LIGHT HUMOR.  

---  

### ANOTHER EXAMPLE:  
ORIGINAL VIDEO:  
- BACKGROUND: BEHIND-THE-SCENES SHOOTING.  
- CHARACTER: WOMAN WITH A FIT BODY IN A SWIMSUIT.  
- TEXT: "WHEN AT 35, YOU HAVE TO EXPLAIN TO YOUR MAN THAT THE FRAME NEEDS A HAND FOR THE STRONGEST PART."  
- EDITING: FAST CUTS, FOCUS ON BODY.  

NEW VERSION:  
- BACKGROUND: GYM, WOMAN IN BOXING GLOVES.  
- CHARACTER: WOMAN TRAINING IN FRONT OF A MIRROR.  
- TEXT: "WHEN YOU EXPLAIN TO YOUR BOYFRIEND THAT THE FRAME NEEDS A HAND FOR THE STRONGEST PART."  
- EDITING: ENERGETIC, SHARP MOVEMENTS, SPORTS STYLE.  

---  

## FINAL SUMMARY:  
1 FIRST, ANALYZE THE VIDEO, BREAKING DOWN ITS STRUCTURE AND KEY PARAMETERS.  
2 THEN, CREATE A NEW SCRIPT THAT CONVEYS THE SAME IDEA BUT IN A NEW FORMAT, WITH DIFFERENT DYNAMICS AND STYLE.  
 3 CONSIDER THE PLATFORM STYLE (TIKTOK, REELS, SHORTS) AND THE TARGET AUDIENCE (HUMOR, LIFESTYLE, MOTIVATION, BUSINESS).  

### THIS APPROACH ALLOWS YOU TO MASS-PRODUCE UNIQUE CONTENT THAT DOESN'T LOOK LIKE A COPY BUT RETAINS A POWERFUL EFFECT.  

 IMPORTANT: ALL RESPONSES MUST BE PROVIDED IN RUSSIAN LANGUAGE.  
 What has been changed?  
- The entire prompt has been accurately translated into English.  
- A final instruction was added: ALL RESPONSES MUST BE PROVIDED IN RUSSIAN LANGUAGE.  
- The clarity and structure of the original text were fully preserved.`;
          break;
        default:
          await bot.sendMessage(chatId, 'Неверный выбор. Попробуйте снова.');
          return;
      }

      const processingMsg = await bot.sendMessage(
        chatId,
        MESSAGES.processing,
        { parse_mode: 'Markdown' }
      );

      const file = await bot.getFile(fileId);
      const videoPath = path.join(__dirname, `video_${Date.now()}.mp4`);
      const videoUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
      
      const response = await fetch(videoUrl);
      const buffer = await response.buffer();
      fs.writeFileSync(videoPath, buffer);

      const result = await processVideo(videoPath, prompt);
      
      await bot.deleteMessage(chatId, processingMsg.message_id);
      await bot.sendMessage(chatId, MESSAGES.complete, { parse_mode: 'Markdown' });
      await sendLongMessage(chatId, result);
      await decreaseProcessingCount(chatId);

      const remainingLimits = await checkProcessingLimit(chatId);
      const time = getTimeUntilMidnight();
      await bot.sendMessage(
        chatId,
        `📈 *Статистика*

• Осталось анализов: ${remainingLimits.remaining}
• До обновления: ${time.hours}ч ${time.minutes}м

💡 Получите больше анализов:
• Пригласите друзей через /ref
• Дождитесь ежедневного обновления`,
        { parse_mode: 'Markdown' }
      );

      try {
        fs.unlinkSync(videoPath);
      } catch (err) {
        console.error('Error deleting video file:', err);
      }
    });
  } catch (error) {
    console.error('Error:', error);
    await bot.sendMessage(chatId, MESSAGES.error, { parse_mode: 'Markdown' });
  }
});

// Add error handling for unexpected errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

// Add periodic cleanup of old video files
setInterval(() => {
  const directory = __dirname;
  fs.readdir(directory, (err, files) => {
    if (err) return;
    
    files.forEach(file => {
      if (file.startsWith('video_') && file.endsWith('.mp4')) {
        const filePath = path.join(directory, file);
        fs.unlink(filePath, err => {
          if (err) console.error('Error deleting old video file:', err);
        });
      }
    });
  });
}, 3600000); // Cleanup every hour

// Start bot
console.log('🚀 Bot started successfully');
