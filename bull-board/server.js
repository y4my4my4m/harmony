import express from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';

const PORT = parseInt(process.env.PORT || '3003', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const USER = process.env.BULL_BOARD_USER || 'admin';
const PASSWORD = process.env.BULL_BOARD_PASSWORD;

if (!PASSWORD) {
  console.error('BULL_BOARD_PASSWORD is required');
  process.exit(1);
}

const QUEUE_PREFIX = 'harmony';
const QUEUE_NAMES = [
  'federate-post',
  'federate-reaction',
  'federate-follow',
  'federate-dm',
  'federate-channel-message',
  'federate-channel-message-edit',
  'federate-channel-message-delete',
  'federate-channel-reaction',
  'federate-message-reaction',
  'federate-channel-crud',
  'federate-category-crud',
  'federate-server-update',
  'federate-block',
  'federate-report',
  'federate-profile',
  'federate-thread',
  'federate-voice-join',
  'federate-voice-leave',
  'federate-group-invite',
  'send-push-notification',
  'maintenance',
];

const redisOpts = (() => {
  const url = new URL(REDIS_URL);
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379', 10),
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
})();

const queues = QUEUE_NAMES.map(
  (name) => new Queue(name, { connection: redisOpts, prefix: QUEUE_PREFIX })
);

const BASE_PATH = process.env.BULL_BOARD_BASE_PATH || '';

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath(BASE_PATH);

createBullBoard({
  queues: queues.map((q) => new BullMQAdapter(q)),
  serverAdapter,
});

const app = express();

app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
    return res.status(401).send('Authentication required');
  }

  const credentials = Buffer.from(auth.slice(6), 'base64').toString();
  const [user, pass] = credentials.split(':');

  if (user !== USER || pass !== PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
    return res.status(401).send('Invalid credentials');
  }

  next();
});

app.use(BASE_PATH || '/', serverAdapter.getRouter());

app.listen(PORT, () => {
  console.log(`Bull Board listening on port ${PORT}`);
  console.log(`Monitoring ${queues.length} queues (prefix: ${QUEUE_PREFIX})`);
});
