import mongoose from 'mongoose';

const objectid = mongoose.Schema.Types.ObjectId;
const mixed = mongoose.Schema.Types.Mixed;
const User = mongoose.model('User', new mongoose.Schema({ email: { type: String, unique: true }, name: String }, { timestamps: true }));
const Account = mongoose.model('Account', new mongoose.Schema({ name: String, sequence: { type: Number, default: 0 } }));
const membership = new mongoose.Schema({ account: objectid, user: objectid, role: { type: String, enum: ['owner', 'admin', 'member'] } });
membership.index({ account: 1, user: 1 }, { unique: true });
const Member = mongoose.model('Member', membership);
const Group = mongoose.model('Group', new mongoose.Schema({ account: objectid, name: String, users: [objectid] }));
const Ticket = mongoose.model('Ticket', new mongoose.Schema({ hash: { type: String, unique: true }, kind: String, email: String, account: objectid, data: mixed, expires: Date }));
const Library = mongoose.model('Library', new mongoose.Schema({ account: objectid, creator: objectid, name: String, shared: Boolean, editable: Boolean, members: [objectid], groups: [objectid], yaml: String, snippets: [mixed], revision: Number, deleted: { type: Boolean, default: false } }));
const Device = mongoose.model('Device', new mongoose.Schema({ account: objectid, user: objectid, name: String, access: String, access_expires: Date, refresh: String, refresh_expires: Date, revoked: { type: Boolean, default: false } }, { timestamps: true }));
const change = new mongoose.Schema({ account: objectid, sequence: Number, library: objectid, kind: String });
change.index({ account: 1, sequence: 1 }, { unique: true });
const Change = mongoose.model('Change', change);
const operation = new mongoose.Schema({ account: objectid, user: objectid, operation: String, fingerprint: String, result: mixed });
operation.index({ account: 1, user: 1, operation: 1 }, { unique: true });
const Operation = mongoose.model('Operation', operation);
const Conflict = mongoose.model('Conflict', new mongoose.Schema({ account: objectid, library: objectid, user: objectid, snippet: String, local: mixed, base: mixed, server: mixed, resolved: { type: Boolean, default: false } }, { timestamps: true }));

export { mongoose, User, Account, Member, Group, Ticket, Library, Device, Change, Operation, Conflict };
