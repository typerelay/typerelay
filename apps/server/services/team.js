import { Member, Group, User, Ticket, Account, Device } from '../model/index.js';
import { Support } from './support.js';
import { Auth } from './auth.js';

export class Team {
	static async list(ctx) {
		const members = await Member.find({ account: ctx.account }).lean();
		const users = await User.find({ _id: { $in: members.map(member => member.user) } }).lean();
		return { invitations: Support.admin(ctx) ? await Ticket.find({ account: ctx.account, kind: 'invite', expires: { $gt: new Date() } }).select('_id email expires').lean() : [], members: members.map(member => ({ ...member, profile: users.find(user => Support.equal(user._id, member.user)) })), groups: await Group.find({ account: ctx.account }).lean() };
	}
	static async invite(ctx, email) {
		Support.assert(Support.admin(ctx), 'Admin required', 403);
		email = Support.text(email, 254).toLowerCase();
		Support.assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Invalid email');
		const token = Support.token();
		const invitation = await Ticket.create({ hash: Support.hash(token), kind: 'invite', email, account: ctx.account, expires: new Date(Date.now() + 7 * 86400000) });
		await Auth.mail.sendMail({ from: 'TypeRelay <team@typerelay.local>', to: email, subject: 'Join your TypeRelay team', text: Auth.origin + '/?invite=' + token });
		return { invited: email, invitation: String(invitation._id) };
	}
	static async accept(ctx, token, session) {
		const user = await User.findById(ctx.user).session(session).lean();
		const ticket = await Ticket.findOneAndDelete({ hash: Support.hash(token), kind: 'invite', email: user.email, expires: { $gt: new Date() } }, { session }).lean();
		Support.assert(ticket, 'Invitation invalid, expired, or for another email');
		await Member.updateOne({ account: ticket.account, user: ctx.user }, { $setOnInsert: { role: 'member' } }, { upsert: true, session });
		await Support.change(ticket.account, null, 'membership', session);
		return { account: String(ticket.account) };
	}
	static async member(ctx, id, body, session) {
		const target = await Member.findOne({ _id: Support.id(id), account: ctx.account }).session(session).lean();
		Support.assert(target && target.role !== 'owner' && Support.admin(ctx) && (ctx.role === 'owner' || (target.role === 'member' && !body.role)), 'Cannot change this member', 403);
		if (body.role) {
			Support.assert(['admin', 'member'].includes(body.role) && ctx.role === 'owner', 'Only owners appoint admins', 403);
			await Member.updateOne({ _id: target._id }, { $set: { role: body.role } }, { session });
		} else {
			await Member.deleteOne({ _id: target._id }, { session });
			await Group.updateMany({ account: ctx.account }, { $pull: { users: target.user } }, { session });
			await Device.updateMany({ account: ctx.account, user: target.user }, { $set: { revoked: true } }, { session });
		}
		await Support.change(ctx.account, null, 'membership', session);
		return { member: id, role: body.role || null };
	}
	static async group(ctx, id, body, session) {
		Support.assert(Support.admin(ctx), 'Admin required', 403);
		if (id) Support.assert(await Group.exists({ _id: Support.id(id), account: ctx.account }).session(session), 'Group not found', 404);
		if (body.deleted) await Group.deleteOne({ _id: id, account: ctx.account }, { session });
		else {
			Support.assert(Array.isArray(body.users) && body.users.length <= 1000, 'Invalid group members');
			const users = [...new Set(body.users.map(Support.id))];
			Support.assert(await Member.countDocuments({ account: ctx.account, user: { $in: users } }).session(session) === users.length, 'Member not in account');
			const group = await Group.findOneAndUpdate({ _id: id || new Account()._id, account: ctx.account }, { $set: { name: Support.text(body.name), users } }, { upsert: !id, returnDocument: 'after', session }).lean();
			await Support.change(ctx.account, null, 'membership', session);
			return { group };
		}
		await Support.change(ctx.account, null, 'membership', session);
		return { deleted: id };
	}
}
