import 'dotenv/config';
import { createPool } from '@echo/database';
if (!process.env.DATABASE_URL) {
  console.log('Echo worker idle: DATABASE_URL is not configured.');
} else {
  const pool = createPool();
  const workerId = process.env.ECHO_WORKER_ID ?? `echo-worker-${process.pid}`;
  const timer = setInterval(async () => {
    try {
      const result = await pool.query(`UPDATE queue_jobs SET status='RUNNING',locked_at=now(),locked_by=$1,attempts=attempts+1 WHERE id=(SELECT id FROM queue_jobs WHERE status='PENDING' AND available_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,queue_name`, [workerId]);
      if (result.rows[0]) console.log('Claimed job', result.rows[0]);
    } catch (error) { console.error(error); }
  }, 5_000);
  const stop = async () => { clearInterval(timer); await pool.end(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
