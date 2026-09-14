import { Cron } from 'croner';
import { Libraries } from './libraries.js';
import { Billing } from './billing.js';
import { WhiteLabel } from './white_label.js';

export class Scheduler {
	static start({ CronClass = Cron, cleanup = () => Libraries.cleanup(), expireTrials = () => Billing.runTrialExpiry(), reconcileWhiteLabel = () => WhiteLabel.reconcile(), logger = console } = {}) {
		let running = false;
		const cleanupJob = new CronClass('30 2 * * *', { protect: true }, async () => {
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
		const trialJob = new CronClass('*/5 * * * *', { protect: true }, async () => {
			try { const summary = await expireTrials(); if (summary.expired) logger.log(`Trial lifecycle complete: downgraded ${summary.expired} accounts to Free`); } catch (error) { logger.error(`Trial lifecycle failed: ${error.message}`); }
		});
		const whiteLabelJob = new CronClass('*/5 * * * *', { protect: true }, async () => {
			try { const summary = await reconcileWhiteLabel(); if (summary.checked) logger.log(`White-label reconciliation complete: checked ${summary.checked}, updated ${summary.updated}, failed ${summary.failed}`); } catch (error) { logger.error(`White-label reconciliation failed: ${error.message}`); }
		});
		return { cleanupJob, trialJob, whiteLabelJob };
	}
}
