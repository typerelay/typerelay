import { AdminAccounts } from './admin_accounts.js';
import { ProductUpdates } from './product_updates.js';
import { Cron } from 'croner';
import { Libraries } from './libraries.js';
import { Billing } from './billing.js';
import { WhiteLabel } from './white_label.js';
import { Helpmonks } from './helpmonks.js';

export class Scheduler {
	static start({ CronClass = Cron, cleanup = () => Libraries.cleanup(), expireTrials = () => Billing.runTrialExpiry(), enrollTrialUsers = () => Helpmonks.enrollTrialUsers(), reconcileWhiteLabel = () => WhiteLabel.reconcile(), purgeAccounts = () => AdminAccounts.recover(), syncProductUpdates = () => ProductUpdates.syncProductUpdates(), productUpdatesEnabled = ProductUpdates.enabled(), logger = console } = {}) {
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
		const helpmonksJob = new CronClass('* * * * *', { protect: true }, async () => {
			try { const summary = await enrollTrialUsers(); if (summary.checked) logger.log(`Helpmonks trial sequence complete: enrolled ${summary.enrolled}, retrying ${summary.retrying}, failed ${summary.failed}`); } catch (error) { logger.error(`Helpmonks trial sequence failed: ${error.message}`); }
		});
		const whiteLabelJob = new CronClass('*/5 * * * *', { protect: true }, async () => {
			try { const summary = await reconcileWhiteLabel(); if (summary.checked) logger.log(`White-label reconciliation complete: checked ${summary.checked}, updated ${summary.updated}, failed ${summary.failed}`); } catch (error) { logger.error(`White-label reconciliation failed: ${error.message}`); }
		});
		const deletionJob = new CronClass('* * * * *', { protect: true }, async () => { try { await purgeAccounts(); } catch (error) { logger.error('Account deletion recovery failed'); } });
		let productUpdatesJob = null;
		if (productUpdatesEnabled) {
			let syncing = false;
			const sync = async () => {
				if (syncing) return;
				syncing = true;
				try { const result = await syncProductUpdates(); logger.log(`Product updates synced: ${result.fetched} posts`); } catch (error) { logger.error(`Product update sync failed: ${error.message}`); } finally { syncing = false; }
			};
			productUpdatesJob = new CronClass('*/15 * * * *', { protect: true }, sync);
			void sync();
		}
		return { cleanupJob, trialJob, helpmonksJob, whiteLabelJob, deletionJob, productUpdatesJob };
	}
}
