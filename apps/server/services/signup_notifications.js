import { SignupNotification } from '../model/index.js';

export class SignupNotifications {
	static maxAttempts = 10;
	static retryDelay = 5 * 60000;
	static messageId(account) { return `<typerelay-signup-${String(account).replace(/[^a-zA-Z0-9._-]/g, '-')}@typerelay.com>`; }
	static date(value = new Date()) {
		const date = new Date(value);
		const months = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
		const day = date.getDate();
		const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th');
		return `${months[date.getMonth()]} ${day}${suffix} ${date.getFullYear()}`;
	}
	static async create(user, account, session) {
		const [notification] = await SignupNotification.create([{ account: account._id, user: user._id, email: user.email, name: user.name || '', message_id: SignupNotifications.messageId(account._id) }], { session });
		return notification;
	}
	static message(notification) {
		const date = SignupNotifications.date(notification.createdAt);
		return { to: 'hi@typerelay.com', replyTo: notification.email, messageId: notification.message_id, subject: `Type Relay signup: ${notification.email} - Date ${date}`, text: ['New Type Relay signup', `Name: ${notification.name || 'Not provided'}`, `Email: ${notification.email}`, `Account ID: ${notification.account}`, `Date: ${date}`].join('\n') };
	}
	static async deliver(id, sendMail, now = new Date()) {
		const notification = await SignupNotification.findOneAndUpdate({ _id: id, status: 'pending', attempts: { $lt: SignupNotifications.maxAttempts }, $or: [{ next_attempt_at: null }, { next_attempt_at: { $lte: now } }] }, { $inc: { attempts: 1 }, $set: { last_attempt_at: now, next_attempt_at: new Date(+now + SignupNotifications.retryDelay), last_error: '', failed_at: null } }, { returnDocument: 'after' }).lean();
		if (!notification) return null;
		try {
			await sendMail(SignupNotifications.message(notification));
			const sentAt = new Date();
			await SignupNotification.updateOne({ _id: notification._id, status: 'pending' }, { $set: { status: 'sent', sent_at: sentAt, next_attempt_at: null, failed_at: null, last_error: '' } });
			return { status: 'sent', sent_at: sentAt };
		} catch (error) {
			const failed = notification.attempts >= SignupNotifications.maxAttempts;
			await SignupNotification.updateOne({ _id: notification._id, status: 'pending' }, { $set: { status: failed ? 'failed' : 'pending', failed_at: failed ? new Date() : null, last_error: String(error.message || error).slice(0, 500) } });
			throw error;
		}
	}
	static async reconcile(sendMail, now = new Date()) {
		const records = await SignupNotification.find({ status: 'pending', attempts: { $lt: SignupNotifications.maxAttempts }, $or: [{ next_attempt_at: null }, { next_attempt_at: { $lte: now } }] }).select('_id').limit(25).lean();
		let sent = 0; let retrying = 0; let failed = 0;
		for (const record of records) {
			try { if (await SignupNotifications.deliver(record._id, sendMail, now)) sent++; }
			catch { const current = await SignupNotification.findById(record._id).select('status').lean(); if (current?.status === 'failed') failed++; else retrying++; }
		}
		return { checked: records.length, sent, retrying, failed };
	}
}
