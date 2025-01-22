// Импорт необходимых библиотек
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const {GoogleAIFileManager,FileState,GoogleAICacheManager,} = require("@google/generative-ai/server");
const { v4: uuidv4 } = require('uuid'); // Для Idempotence-Key
require('dotenv').config();
// const { fileManager, model } = require('gemini-sdk'); // Подключите SDK Gemini

// Создаем экземпляр бота
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const genAI = new GoogleGenerativeAI(process.env.GENAI1);
const fileManager = new GoogleAIFileManager(process.env.GENAI1);
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});

// Настройка ЮKassa
const shopId = 'YOUR_SHOP_ID';
const secretKey = 'YOUR_SECRET_KEY';

// Настройка базы данных
const db = new sqlite3.Database('users.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    video_credits INTEGER DEFAULT 5,
    invited_by INTEGER DEFAULT NULL
  )`);
});

// Функция для добавления пользователя в базу данных
function addUser(userId, username, callback) {
  db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => {
    if (err) return console.error(err);
    if (!row) {
      db.run('INSERT INTO users (id, username) VALUES (?, ?)', [userId, username], callback);
    } else {
      callback();
    }
  });
}

// Функция для обновления количества обработок
function updateCredits(userId, credits, callback) {
  db.run('UPDATE users SET video_credits = video_credits + ? WHERE id = ?', [credits, userId], callback);
}

// Функция для получения информации о пользователе
function getUser(userId, callback) {
  db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => {
    if (err) return console.error(err);
    callback(row);
  });
}

// Функция для создания платежа
function createPayment(amount, chatId, plan, requests) {
  const idempotenceKey = uuidv4();
  const paymentData = {
      amount: {
          value: (amount / 100).toFixed(2), // Сумма в рублях
          currency: "RUB"
      },
      confirmation: {
          type: "redirect",
          return_url: `https://t.me/${bot.username}`
      },
      capture: true,
      description: `Оплата подписки: ${plan}`
  };

  return axios.post('https://api.yookassa.ru/v3/payments', paymentData, {
      auth: {
          username: shopId,
          password: secretKey
      },
      headers: {
          'Idempotence-Key': idempotenceKey
      }
  })
  .then(response => {
      const payment = response.data;
      const paymentUrl = payment.confirmation.confirmation_url;
      const paymentId = payment.id;

      // Сохраняем информацию о платеже
      payments[chatId] = { paymentId, plan, amount, requests };

      console.log(`Платеж создан: ${paymentId}, сумма: ${amount/100} рублей, план: ${plan}`);

      // Начинаем проверку статуса платежа сразу после создания
      checkPaymentStatus(paymentId, chatId, plan, amount, requests);

      return paymentUrl; // Возвращаем ссылку на оплату
  })
  .catch(error => {
      console.error('Ошибка при создании платежа:', error.response.data);
      throw new Error('Ошибка при создании платежа. Повторите попытку позже.');
  });
}

// Функция для проверки статуса платежа
function checkPaymentStatus(paymentId, chatId, plan, amount, requests) {
  axios.get(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
      auth: {
          username: shopId,
          password: secretKey
      }
  })
  .then(response => {
      const payment = response.data;

      if (payment.status === 'succeeded') {
          bot.sendMessage(chatId, `Вы успешно оплатили подписку: ${plan} с ${requests} запросами!`);
          const chatik = -1002478872141;
          bot.sendMessage(chatik, `Какой-то пользователь купил подписку: ${plan}\n\nНа сумму ${amount/100} рублей`);

          // Проверка существования пользователя и сохранение подписки
          db.get(`SELECT * FROM users WHERE id = ?`, [chatId], (err, row) => {
              if (err) {
                  console.error('Ошибка при проверке пользователя в базе:', err);
                  bot.sendMessage(chatId, 'Произошла ошибка при проверке вашего статуса.');
                  return;
              }

              if (!row) {
                  db.run(`INSERT INTO users (id, username, video_credits) 
                          VALUES (?, ?, ?)`,
                      [chatId, "unknown", requests],
                      (err) => {
                          if (err) {
                              console.error('Ошибка при добавлении пользователя:', err.message);
                              bot.sendMessage(chatId, 'Произошла ошибка при добавлении пользователя.');
                          } else {
                              console.log(`Подписка ${plan} на сумму ${amount/100} рублей с ${requests} запросами сохранена для нового пользователя ${chatId}.`);
                          }
                      }
                  );
              } else {
                  db.run(`UPDATE users SET video_credits = video_credits + ? WHERE id = ?`,
                      [requests, chatId],
                      (err) => {
                          if (err) {
                              console.error('Ошибка при обновлении подписки:', err.message);
                              bot.sendMessage(chatId, 'Произошла ошибка при обновлении подписки.');
                          } else {
                              console.log(`Подписка ${plan} на сумму ${amount/100} рублей с ${requests} запросами обновлена для пользователя ${chatId}.`);
                          }
                      }
                  );
              }
          });

          delete payments[chatId]; // Удаляем информацию о платеже, так как он завершен
      } else if (payment.status === 'pending') {
          setTimeout(() => checkPaymentStatus(paymentId, chatId, plan, amount, requests), 30000);
      } else {
          console.log(`Платеж завершен с другим статусом: ${payment.status}`);
          bot.sendMessage(chatId, `Платеж завершен с другим статусом: ${payment.status}.`);
      }
  })
  .catch(error => {
      console.error('Ошибка при проверке статуса платежа:', error.response?.data || error.message);
      bot.sendMessage(chatId, 'Произошла ошибка при проверке статуса платежа.');
  });
}

// Обработка команды /start
bot.onText(/\/start(?:\s+(\d+))?/, (msg, match) => {
  const userId = msg.from.id;
  const username = msg.from.username || 'unknown';
  const invitedBy = match[1];

  addUser(userId, username, () => {
    if (invitedBy) {
      updateCredits(invitedBy, 5, () => {
        bot.sendMessage(invitedBy, 'Ваш друг присоединился! Вы получили 5 дополнительных обработок видео.');
      });
    }
    bot.sendMessage(
      userId,
      'Добро пожаловать! У вас есть 5 бесплатных обработок видео.',
      mainMenu()
    );
  });
});

// Главное меню с инлайн кнопками
function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Обработать видео', callback_data: 'process_video' }],
        [{ text: 'Пригласить друга', callback_data: 'invite_friend' }],
        [{ text: 'Личный кабинет', callback_data: 'profile' }],
        [{ text: 'Купить обработки', callback_data: 'buy_credits' }]
      ]
    }
  };
};

// Обработка нажатий на инлайн кнопки
bot.on('callback_query', (query) => {
  const userId = query.from.id;
  const data = query.data;

  if (data === 'process_video') {
    getUser(userId, (user) => {
      if (user.video_credits > 0) {
        bot.sendMessage(userId, 'Отправьте видео для обработки.');

        bot.once('video', async (msg) => {
          const chatId = msg.chat.id;
          try {
            bot.sendMessage(chatId, "Оцениваю видео")

            const videoId = msg.video.file_id;

            // Получаем URL для скачивания видео
            const file = await bot.getFile(videoId);
            const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

            // Скачиваем файл на сервер
            const videoResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
            const filePath = `/tmp/${videoId}.mp4`; // Путь для временного сохранения файла
            fs.writeFileSync(filePath, videoResponse.data);

            // Загружаем файл в Gemini
            const uploadResult = await fileManager.uploadFile(filePath, { mimeType: "video/mp4" });

            // Подготовка файла для запроса
            const videoPart = {
              fileData: {
                fileUri: uploadResult.file.uri,
                mimeType: uploadResult.file.mimeType,
              },
            };

            const prompt = `Оцени видео по 10 бальной шкале и напиши что думаешь о нем`;

            // Отправляем запрос в модель Gemini
            const generateResult = await model.generateContent([prompt, videoPart]);
            const response = await generateResult.response;
            const responseText = await response.text();

            // Отправляем результат пользователю
            if (!responseText || responseText.toLowerCase().includes("не могу анализировать")) {
              throw new Error('Модель отказалась анализировать видео');
            }

            await bot.sendMessage(chatId, `${responseText}`);

            // После успешной обработки уменьшаем счетчик
            updateCredits(userId, -1, () => {});
          } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, 'Произошла ошибка при обработке видео. Попробуйте еще раз.');
          }
        });
      } else {
        bot.sendMessage(userId, 'У вас недостаточно обработок. Вы можете приобрести дополнительные.', mainMenu());
      }
    });
  } else if (data === 'invite_friend') {
    const inviteLink = `https://t.me/YOUR_BOT_USERNAME?start=${userId}`;
    bot.sendMessage(userId, `Приглашайте друзей с помощью этой ссылки: ${inviteLink}`);
  } else if (data === 'profile') {
    getUser(userId, (user) => {
      bot.sendMessage(userId, `Ваш профиль:\n\nUsername: ${user.username}\nОстаток обработок: ${user.video_credits}`, mainMenu());
    });
  } else if (data === 'buy_credits') {
    const inviteLink = `https://t.me/YOUR_BOT_USERNAME?start=${userId}`;
    bot.sendMessage(userId, 'Вы можете купить дополнительные обработки видео. Чтобы начать, выберите план подписки.', {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'План 1 - 10 обработок', callback_data: 'buy_plan_1' }],
                [{ text: 'План 2 - 30 обработок', callback_data: 'buy_plan_2' }],
                [{ text: 'План 3 - 100 обработок', callback_data: 'buy_plan_3' }]
            ]
        }
    });
  } else if (data === 'buy_plan_1') {
    createPayment(500, userId, 'План 1', 10).then(paymentUrl => {
      bot.sendMessage(userId, `Для оплаты плана 1 (10 обработок видео) перейдите по следующей ссылке: ${paymentUrl}`);
    }).catch(error => {
      bot.sendMessage(userId, error.message);
    });
  } else if (data === 'buy_plan_2') {
    createPayment(1500, userId, 'План 2', 30).then(paymentUrl => {
      bot.sendMessage(userId, `Для оплаты плана 2 (30 обработок видео) перейдите по следующей ссылке: ${paymentUrl}`);
    }).catch(error => {
      bot.sendMessage(userId, error.message);
    });
  } else if (data === 'buy_plan_3') {
    createPayment(4000, userId, 'План 3', 100).then(paymentUrl => {
      bot.sendMessage(userId, `Для оплаты плана 3 (100 обработок видео) перейдите по следующей ссылке: ${paymentUrl}`);
    }).catch(error => {
      bot.sendMessage(userId, error.message);
    });
  }
});

// Запуск бота
console.log('Бот запущен!');


// require('dotenv').config();
// const TelegramBot = require('node-telegram-bot-api');
// const fs = require('fs');
// const path = require('path');
// const { GoogleGenerativeAI } = require('@google/generative-ai');

// // Configure environment variables
// const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN_VIDEO;
// const BOT_USERNAME = '@ChatClubhelper_bot';

// const BASE_URL = 'http://127.0.0.1:8080';

// // Initialize bot and Gemini AI
// const bot = new TelegramBot(TELEGRAM_TOKEN, {
//   polling: true });
// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// // Сообщения
// const MESSAGES = {
//   processing: '🔄 *Начинаю анализ видео*\n\n⏳ Пожалуйста, подождите...',
//   complete: '✅ *Анализ завершен*\n\n📊 Результаты анализа:',
//   error: '❌ *Ошибка при обработке видео*\n\nПожалуйста, убедитесь, что видео:\n• Не превышает 20МБ\n• В формате MP4\n• Длительностью не более 2 минут'
// };

// // Функция для извлечения кадров из видео
// async function extractFramesFromVideo(videoPath) {
//   const outputDir = path.join(__dirname, 'frames');
  
//   // Создаем директорию для кадров, если её нет
//   if (!fs.existsSync(outputDir)) {
//     fs.mkdirSync(outputDir);
//   } else {
//     // Очищаем директорию от старых кадров
//     const files = fs.readdirSync(outputDir);
//     for (const file of files) {
//       fs.unlinkSync(path.join(outputDir, file));
//     }
//   }

//   return new Promise((resolve, reject) => {
//     let frames = [];
    
//     ffmpeg(videoPath)
//       .on('filenames', (filenames) => {
//         frames = filenames.map(f => path.join(outputDir, f));
//       })
//       .on('end', () => resolve(frames))
//       .on('error', (err) => reject(err))
//       .takeScreenshots({
//         count: 5,
//         timemarks: ['10%', '30%', '50%', '70%', '90%'],
//         filename: 'frame-%i.jpg'
//       }, outputDir);
//   });
// }

// // Функция для оптимизации изображения
// async function optimizeImage(imagePath) {
//   try {
//     return await sharp(imagePath)
//       .resize(512, 512, {
//         fit: 'inside',
//         withoutEnlargement: true
//       })
//       .jpeg({ quality: 80 })
//       .toBuffer();
//   } catch (error) {
//     console.error('Error optimizing image:', error);
//     throw error;
//   }
// }

// // Анализ видео через Gemini
// async function processVideo(videoPath) {
//   try {
//     // Извлекаем кадры
//     const framesPaths = await extractFramesFromVideo(videoPath);
//     console.log('Frames extracted:', framesPaths);

//     // Обрабатываем кадры
//     const processedFrames = [];
//     for (const framePath of framesPaths) {
//       try {
//         const optimizedBuffer = await optimizeImage(framePath);
//         const base64Data = optimizedBuffer.toString('base64');
//         processedFrames.push({
//           inlineData: {
//             data: base64Data,
//             mimeType: 'image/jpeg'
//           }
//         });
//       } catch (err) {
//         console.error(`Error processing frame ${framePath}:`, err);
//       }
//     }

//     if (processedFrames.length === 0) {
//       throw new Error('No frames were successfully processed');
//     }

//     // Промпт для анализа
//     const prompt = `Проанализируйте эти кадры из видео и предоставьте детальный анализ:

// 1. ВНЕШНИЙ ВИД И ПОЗА:
// - Осанка и положение тела
// - Жесты и движения
// - Мимика и выражение лица
// - Общее впечатление

// 2. ВИЗУАЛЬНЫЕ АСПЕКТЫ:
// - Качество освещения и композиции
// - Расположение в кадре
// - Использование пространства

// 3. РЕКОМЕНДАЦИИ:
// - Основные сильные стороны
// - Области для улучшения
// - 3-4 конкретных совета`;

//     // Получаем анализ от Gemini
//     const model = genAI.getGenerativeModel({ model: "gemini-pro-vision" });
//     const result = await model.generateContent([...processedFrames, prompt]);
//     const response = await result.response;

//     // Очищаем временные файлы
//     for (const framePath of framesPaths) {
//       try {
//         fs.unlinkSync(framePath);
//       } catch (err) {
//         console.error(`Error deleting frame ${framePath}:`, err);
//       }
//     }

//     return response.text();
//   } catch (error) {
//     console.error('Detailed error in processVideo:', error);
//     throw error;
//   }
// }

// // Отправка длинных сообщений
// async function sendLongMessage(chatId, text) {
//   const maxLength = 4096;
//   let position = 0;
// while (position < text.length) {
//   const chunk = text.slice(position, position + maxLength);
//   position += maxLength;

//   try {
//     await bot.sendMessage(chatId, chunk, {
//       parse_mode: 'Markdown',
//       disable_web_page_preview: true
//     });
    
//     if (position < text.length) {
//       await new Promise(resolve => setTimeout(resolve, 1000));
//     }
//   } catch (error) {
//     console.error('Error sending message chunk:', error);
//   }
// }
// }

// // Обработчик видео для Local Bot API
// bot.on('video', async (msg) => {
// const chatId = msg.chat.id;

// try {
//   const processingMsg = await bot.sendMessage(
//     chatId,
//     MESSAGES.processing,
//     { parse_mode: 'Markdown' }
//   );

//   // Для Local Bot API путь к видео уже доступен
//   const videoPath = msg.video.file_path;
//   console.log('Video path:', videoPath);

//   // Проверяем существование файла
//   if (!fs.existsSync(videoPath)) {
//     throw new Error('Video file not found');
//   }

//   // Обрабатываем видео
//   const result = await processVideo(videoPath);

//   // Удаляем сообщение о процессе
//   await bot.deleteMessage(chatId, processingMsg.message_id);

//   // Отправляем результат
//   await bot.sendMessage(chatId, MESSAGES.complete, { parse_mode: 'Markdown' });
//   await sendLongMessage(chatId, result);

// } catch (error) {
//   console.error('Error in video handler:', error);
//   await bot.sendMessage(chatId, MESSAGES.error, { parse_mode: 'Markdown' });
// }
// });

// // Обработка ошибок
// process.on('uncaughtException', (err) => {
// console.error('Uncaught Exception:', err);
// });

// process.on('unhandledRejection', (err) => {
// console.error('Unhandled Rejection:', err);
// });

// // Запуск бота
// console.log('🚀 Bot started successfully');