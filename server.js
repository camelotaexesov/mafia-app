const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Подключение к PostgreSQL (используем строку из переменной окружения)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:fgtGlidtvngGeaHnbrRxTlZkwUXbhjgX@gondola.proxy.rlwy.net:30771/railway',
  ssl: { rejectUnauthorized: false }
});

// ---------- Таблицы (создаются автоматически) ----------
const createTables = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        vk_id BIGINT UNIQUE,
        nickname VARCHAR(50) NOT NULL,
        avatar VARCHAR(255),
        level INT DEFAULT 1,
        xp INT DEFAULT 0,
        wins INT DEFAULT 0,
        games_played INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        code CHAR(6) UNIQUE NOT NULL,
        host_id INT REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'waiting',
        settings JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        finished_at TIMESTAMP
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS room_players (
        id SERIAL PRIMARY KEY,
        room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        is_bot BOOLEAN DEFAULT FALSE,
        bot_difficulty VARCHAR(20),
        role VARCHAR(20),
        is_alive BOOLEAN DEFAULT TRUE,
        is_ready BOOLEAN DEFAULT FALSE,
        joined_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Таблицы готовы');
  } catch (err) {
    console.error('Ошибка создания таблиц', err);
  } finally {
    client.release();
  }
};
createTables();

// ---------- API ----------

// Создание комнаты
app.post('/api/create_room', async (req, res) => {
  const { vk_id, nickname, avatar, settings } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Найти или создать пользователя
    let userRes = await client.query('SELECT id FROM users WHERE vk_id = $1', [vk_id]);
    let userId;
    if (userRes.rows.length === 0) {
      const newUser = await client.query(
        'INSERT INTO users (vk_id, nickname, avatar) VALUES ($1, $2, $3) RETURNING id',
        [vk_id, nickname, avatar]
      );
      userId = newUser.rows[0].id;
    } else {
      userId = userRes.rows[0].id;
    }
    // Сгенерировать код комнаты
    let code = Math.floor(100000 + Math.random() * 900000).toString();
    let roomRes = await client.query(
      'INSERT INTO rooms (code, host_id, settings) VALUES ($1, $2, $3) RETURNING id',
      [code, userId, JSON.stringify(settings)]
    );
    const roomId = roomRes.rows[0].id;
    // Добавить хоста в участники
    await client.query(
      'INSERT INTO room_players (room_id, user_id, is_ready) VALUES ($1, $2, $3)',
      [roomId, userId, true]
    );
    await client.query('COMMIT');
    res.json({ roomId, code });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Ошибка создания комнаты' });
  } finally {
    client.release();
  }
});

// Присоединение к комнате по коду
app.post('/api/join_room', async (req, res) => {
  const { vk_id, nickname, avatar, code } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Найти или создать пользователя
    let userRes = await client.query('SELECT id FROM users WHERE vk_id = $1', [vk_id]);
    let userId;
    if (userRes.rows.length === 0) {
      const newUser = await client.query(
        'INSERT INTO users (vk_id, nickname, avatar) VALUES ($1, $2, $3) RETURNING id',
        [vk_id, nickname, avatar]
      );
      userId = newUser.rows[0].id;
    } else {
      userId = userRes.rows[0].id;
    }
    // Найти комнату
    const roomRes = await client.query('SELECT id, status FROM rooms WHERE code = $1', [code]);
    if (roomRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Комната не найдена' });
    }
    const room = roomRes.rows[0];
    if (room.status !== 'waiting') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Игра уже началась' });
    }
    // Добавить игрока
    await client.query(
      'INSERT INTO room_players (room_id, user_id, is_ready) VALUES ($1, $2, $3)',
      [room.id, userId, false]
    );
    await client.query('COMMIT');
    res.json({ success: true, roomId: room.id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Ошибка присоединения' });
  } finally {
    client.release();
  }
});

// Получить список игроков в комнате
app.get('/api/room_players/:roomId', async (req, res) => {
  const { roomId } = req.params;
  const result = await pool.query(
    `SELECT u.id, u.nickname, u.avatar, rp.is_ready, rp.is_bot, rp.role, rp.is_alive
     FROM room_players rp
     LEFT JOIN users u ON rp.user_id = u.id
     WHERE rp.room_id = $1`,
    [roomId]
  );
  res.json(result.rows);
});

// Обновить статус готовности игрока
app.post('/api/set_ready', async (req, res) => {
  const { roomId, userId, isReady } = req.body;
  await pool.query(
    'UPDATE room_players SET is_ready = $1 WHERE room_id = $2 AND user_id = $3',
    [isReady, roomId, userId]
  );
  res.json({ success: true });
});

// Начать игру (только хост)
app.post('/api/start_game', async (req, res) => {
  const { roomId, hostId } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Проверить, что пользователь – хост
    const roomRes = await client.query('SELECT host_id FROM rooms WHERE id = $1', [roomId]);
    if (roomRes.rows.length === 0 || roomRes.rows[0].host_id !== hostId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Только хост может начать игру' });
    }
    // Проверить, что минимум 4 игрока готовы
    const playersRes = await client.query(
      'SELECT COUNT(*) FROM room_players WHERE room_id = $1 AND is_ready = true',
      [roomId]
    );
    if (playersRes.rows[0].count < 4) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Недостаточно игроков (минимум 4)' });
    }
    // Обновить статус комнаты
    await client.query('UPDATE rooms SET status = $1 WHERE id = $2', ['playing', roomId]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Ошибка начала игры' });
  } finally {
    client.release();
  }
});

app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});