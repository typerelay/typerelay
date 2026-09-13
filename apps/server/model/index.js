import mongoose from 'mongoose';

const objectid = mongoose.Schema.Types.ObjectId;
const mixed = mongoose.Schema.Types.Mixed;
const User = mongoose.model('User', new mongoose.Schema({ email: { type: String, unique: true }, name: String, password: { type: String, select: false }, totp_secret: { type: String, select: false }, totp_enabled: { type: Boolean, default: false }, totp_step: { type: Number, select: false }, auth_version: { type: Number, default: 0 } }, { timestamps: true }));
const Passkey = mongoose.model('Passkey', new mongoose.Schema({ user: { type: objectid, index: true }, credential_id: { type: String, unique: true }, public_key: { type: String, select: false }, counter: Number, transports: [String], name: String }, { timestamps: true }));
const Account = mongoose.model('Account', new mongoose.Schema({ name: String, sequence: { type: Number, default: 0 } }));
const membership = new mongoose.Schema({ account: objectid, user: objectid, role: { type: String, enum: ['owner', 'admin', 'member'] } });
membership.index({ account: 1, user: 1 }, { unique: true });
const Member = mongoose.model('Member', membership);
const Group = mongoose.model('Group', new mongoose.Schema({ account: objectid, name: String, users: [objectid] }));
const Ticket = mongoose.model('Ticket', new mongoose.Schema({ hash: { type: String, unique: true }, kind: String, email: String, account: objectid, data: mixed, expires: Date }));
const lifecycle = { state: { type: String, enum: ['active', 'trashed', 'purged'], default: 'active' }, trashed_at: Date, trashed_by: String, expires_at: Date };
const Library = mongoose.model('Library', new mongoose.Schema({ account: objectid, creator: objectid, name: String, shared: Boolean, editable: Boolean, members: [objectid], groups: [objectid], purge_readers: [objectid], revision: Number, ...lifecycle }));
const snippetSchema = new mongoose.Schema({ account: objectid, library: objectid, id: String, title: String, trigger: String, content: mixed, position: Number, revision: Number, ...lifecycle });
snippetSchema.index({ library: 1, id: 1 }, { unique: true });
snippetSchema.index({ account: 1, id: 1 }, { unique: true });
snippetSchema.index({ library: 1, trigger: 1 }, { unique: true, partialFilterExpression: { state: 'active', trigger: { $type: 'string', $gt: '' } } });
const Snippet = mongoose.model('Snippet', snippetSchema);
const Migration = mongoose.model('Migration', new mongoose.Schema({ key: { type: String, unique: true }, completed: Boolean }));
const MigrationBackup = mongoose.model('MigrationBackup', new mongoose.Schema({ key: { type: String, unique: true }, source_collection: String, payload: mixed }));
const Device = mongoose.model('Device', new mongoose.Schema({ account: objectid, user: objectid, name: String, access: String, access_expires: Date, refresh: String, refresh_expires: Date, revoked: { type: Boolean, default: false } }, { timestamps: true }));
const change = new mongoose.Schema({ account: objectid, sequence: Number, library: objectid, kind: String, departures: [String] });
change.index({ account: 1, sequence: 1 }, { unique: true });
const Change = mongoose.model('Change', change);
const operation = new mongoose.Schema({ account: objectid, user: objectid, operation: String, fingerprint: String, result: mixed });
operation.index({ account: 1, user: 1, operation: 1 }, { unique: true });
const Operation = mongoose.model('Operation', operation);
const Conflict = mongoose.model('Conflict', new mongoose.Schema({ account: objectid, library: objectid, user: objectid, snippet: String, local: mixed, base: mixed, server: mixed, resolved: { type: Boolean, default: false } }, { timestamps: true }));

export { mongoose, User, Account, Member, Group, Ticket, Library, Device, Change, Operation, Conflict, Passkey, Snippet, Migration, MigrationBackup };

// Integration credentials are independent of desktop enrollment.
export const Integration = mongoose.model('Integration', new mongoose.Schema({ account: objectid, user: objectid, name: String, kind: { type: String, enum: ['pat', 'oauth'] }, scopes: [String], hash: { type: String, select: false }, expires: Date, revoked: { type: Boolean, default: false }, last_used: Date, client: String, resource: String, refresh: { type: String, select: false }, refresh_expires: Date }, { timestamps: true }));
export const OAuthClient = mongoose.model('OAuthClient', new mongoose.Schema({ client_id: { type: String, unique: true }, name: String, redirects: [String] }));
export const IntegrationToken = mongoose.model('IntegrationToken', new mongoose.Schema({ hash: { type: String, unique: true }, grant: objectid, resource: String, expires: Date }, { timestamps: true }));
export const ApiAudit = mongoose.model('ApiAudit', new mongoose.Schema({ account: objectid, user: objectid, credential: objectid, operation: String, status: Number, expires: { type: Date, expires: 0 } }, { timestamps: true }));
IntegrationToken.schema.index({ expires: 1 }, { expireAfterSeconds: 0 });
Ticket.schema.index({ expires: 1 }, { expireAfterSeconds: 0 });
Integration.schema.index({ hash: 1 }, { unique: true, sparse: true });
Integration.schema.index({ refresh: 1 }, { unique: true, sparse: true });
Integration.schema.index({ account: 1, user: 1 });
