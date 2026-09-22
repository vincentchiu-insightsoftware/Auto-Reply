/** 同程序 stdin 控制通道：pause / resume / estop / stop / status。realtime 模式用。 */
import { createInterface } from 'node:readline';
import type { Director } from '../director/director.js';

export function attachStdinControl(director: Director, out: (line: string) => void): () => void {
  const rl = createInterface({ input: process.stdin });
  out('控制指令：pause | resume | estop | stop | status');
  rl.on('line', (line) => {
    const cmd = line.trim().toLowerCase();
    switch (cmd) {
      case 'pause':
        director.pause('stdin');
        out(`→ ${director.state}`);
        break;
      case 'resume':
        void director.resume().then(() => out(`→ ${director.state}`));
        break;
      case 'estop':
        void director.emergencyStop().then((r) => out(`→ ${director.state} 靜音 ${r.silenceMs}ms 取消 ${r.cancelledJobs}`));
        break;
      case 'stop':
        void director.stop('stdin').then(() => out(`→ ${director.state}`));
        break;
      case 'status':
        out(JSON.stringify(director.status()));
        break;
      default:
        out(`未知指令：${cmd}`);
    }
  });
  return () => rl.close();
}
