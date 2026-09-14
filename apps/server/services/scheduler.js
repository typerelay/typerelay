import { Cron } from 'croner';
import { Libraries } from './libraries.js';

export class Scheduler {
	static start({ CronClass = Cron, cleanup = () => Libraries.cleanup(), logger = console } = {}) {
		let running = false;
		return new CronClass('30 2 * * *', { protect: true }, async () => {
			if (running) return;
			running = true;
			try {
				const summary = await cleanup();
				logger.log(`Trash cleanup complete: purged ${summary.libraries} libraries and ${summary.snippets} snippets`);
			} catch (error) {
				logger.error(`Trash cleanup failed: ${error.message}`);
			} finally {
				running = false;
			}
		});
	}
}
