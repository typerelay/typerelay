import mongoose from 'mongoose';

const objectid = mongoose.Schema.Types.ObjectId;
const mixed = mongoose.Schema.Types.Mixed;
const asset = new mongoose.Schema({ url: String, storage_key: { type: String, select: false }, mime_type: String, size: Number, width: Number, height: Number, updated_at: Date }, { _id: false });
const User = mongoose.model('User', new mongoose.Schema({ email: { type: String, unique: true }, name: String, password: { type: String, select: false }, totp_secret: { type: String, select: false }, totp_enabled: { type: Boolean, default: false }, totp_step: { type: Number, select: false }, auth_version: { type: Number, default: 0 }, activity_sequence: { type: Number, default: 0 }, product_updates_seen_at: { type: Date, default: Date.now, select: false } }, { timestamps: true }));
const Passkey = mongoose.model('Passkey', new mongoose.Schema({ user: { type: objectid, index: true }, credential_id: { type: String, unique: true }, public_key: { type: String, select: false }, counter: Number, transports: [String], name: String }, { timestamps: true }));
const accountSchema = new mongoose.Schema({
	name: String,
	is_active: { type: Boolean, default: true },
	admin_revision: { type: Number, default: 0 },
	activity_sequence: { type: Number, default: 0 },
	admin_override: { plan: { type: String, enum: ['free', 'pro', 'team', null], default: null }, limits: { people: { type: Number, default: null }, snippets: { type: Number, default: null }, libraries: { type: Number, default: null }, machines: { type: Number, default: null } } },
	deletion: { requested_at: Date, stage: String, error: String, users: [objectid], grants: [objectid], lease: String, lease_until: Date },
	sequence: { type: Number, default: 0 },
	plan: { type: String, enum: ['free', 'pro', 'team'], default: 'free' },
	billing: {
		stripe_customer_id: { type: String, select: false },
		stripe_subscription_id: { type: String, select: false },
		stripe_free_subscription_id: { type: String, select: false },
		price_id: { type: String, default: '' },
		seat_quantity: { type: Number, default: 1 },
		status: { type: String, enum: ['incomplete', 'checkout_pending', 'trialing', 'trial_expired', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete_expired'], default: 'incomplete' },
		trial_source: { type: String, enum: ['no_card', 'stripe', null], default: null },
		trial_started_at: { type: Date, default: null },
		trial_ends_at: { type: Date, default: null },
		status_changed_at: { type: Date, default: null },
		helpmonks_sequence: {
			status: { type: String, enum: ['pending', 'completed', 'failed', null], default: null },
			attempts: { type: Number, default: 0 },
			next_attempt_at: { type: Date, default: null },
			last_error: { type: String, default: '' },
			contact_id: { type: String, default: '' },
			enrolled_at: { type: Date, default: null },
		},
		scheduled_change: {
			plan: { type: String, enum: ['free', 'pro', 'team'] },
			seat_quantity: Number,
			effective_at: Date,
			schedule_id: { type: String, select: false },
		},
	},
	white_label: {
		logo: { type: asset, default: null },
		favicon: { type: asset, default: null },
		login_logo: { type: asset, default: null },
		hostname: { type: String, default: '' },
		state: { type: String, enum: ['unconfigured', 'pending_dns', 'pending_ssl', 'active', 'disabled_by_plan', 'error'], default: 'unconfigured' },
		cloudflare_hostname_id: { type: String, default: '', select: false },
		cloudflare_hostname_status: { type: String, default: '' },
		cloudflare_ssl_status: { type: String, default: '' },
		dns_verified_at: { type: Date, default: null },
		cloudflare_checked_at: { type: Date, default: null },
		next_check_at: { type: Date, default: null },
		disabled_at: { type: Date, default: null },
		last_error: { type: String, default: '' },
	},
}, { timestamps: true });
accountSchema.index({ 'white_label.hostname': 1 }, { unique: true, partialFilterExpression: { 'white_label.hostname': { $type: 'string', $gt: '' } } });
accountSchema.index({ 'billing.helpmonks_sequence.status': 1, 'billing.helpmonks_sequence.next_attempt_at': 1 });
accountSchema.index({ 'deletion.requested_at': 1, 'deletion.stage': 1 });
const Account = mongoose.model('Account', accountSchema);
const membership = new mongoose.Schema({ account: objectid, user: objectid, role: { type: String, enum: ['owner', 'admin', 'member'] } });
membership.index({ account: 1, user: 1 }, { unique: true });
const Member = mongoose.model('Member', membership);
const Group = mongoose.model('Group', new mongoose.Schema({ account: objectid, name: String, users: [objectid] }));
const Ticket = mongoose.model('Ticket', new mongoose.Schema({ hash: { type: String, unique: true }, kind: String, email: String, account: objectid, data: mixed, expires: Date }));
const signupNotificationSchema = new mongoose.Schema({ account: { type: objectid, required: true, unique: true, index: true }, user: { type: objectid, required: true, index: true }, email: { type: String, required: true }, name: { type: String, default: '' }, status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending', index: true }, attempts: { type: Number, default: 0 }, next_attempt_at: { type: Date, default: null }, last_attempt_at: { type: Date, default: null }, sent_at: { type: Date, default: null }, failed_at: { type: Date, default: null }, last_error: { type: String, default: '' }, message_id: { type: String, required: true } }, { timestamps: true });
signupNotificationSchema.index({ status: 1, next_attempt_at: 1 });
const SignupNotification = mongoose.model('SignupNotification', signupNotificationSchema);
const lifecycle = { state: { type: String, enum: ['active', 'trashed', 'purged'], default: 'active' }, trashed_at: Date, trashed_by: String, expires_at: Date };
const Library = mongoose.model('Library', new mongoose.Schema({ account: objectid, creator: objectid, name: String, shared: Boolean, editable: Boolean, members: [objectid], groups: [objectid], purge_readers: [objectid], revision: Number, ...lifecycle }));
const snippetSchema = new mongoose.Schema({ account: objectid, library: objectid, id: String, title: String, trigger: String, content: mixed, position: Number, revision: Number, ...lifecycle }, { timestamps: true });
snippetSchema.index({ library: 1, id: 1 }, { unique: true });
snippetSchema.index({ account: 1, id: 1 }, { unique: true });
snippetSchema.index({ library: 1, trigger: 1 }, { unique: true, partialFilterExpression: { state: 'active', trigger: { $type: 'string', $gt: '' } } });
const Snippet = mongoose.model('Snippet', snippetSchema);
const snippetAssetSchema = new mongoose.Schema({ account: objectid, id: String, data: { type: Buffer, select: false }, mime_type: String, size: Number, width: Number, height: Number, animated: Boolean, source_urls: [String], last_referenced_at: Date }, { timestamps: true });
snippetAssetSchema.index({ account: 1, id: 1 }, { unique: true });
snippetAssetSchema.index({ account: 1, last_referenced_at: 1 });
const SnippetAsset = mongoose.model('SnippetAsset', snippetAssetSchema);
const Migration = mongoose.model('Migration', new mongoose.Schema({ key: { type: String, unique: true }, completed: Boolean }));
const MigrationBackup = mongoose.model('MigrationBackup', new mongoose.Schema({ key: { type: String, unique: true }, source_collection: String, payload: mixed }));
const Device = mongoose.model('Device', new mongoose.Schema({ account: objectid, user: objectid, name: String, oauth_client: { type: String, enum: ['typerelay-desktop', 'typerelay-mobile'] }, client_type: { type: String, enum: ['desktop', 'cli', 'mobile'] }, os: { type: String, enum: ['macos', 'windows', 'linux', 'ios', 'android', 'web'] }, last_active: Date, access: String, access_expires: Date, refresh: String, refresh_expires: Date, revoked: { type: Boolean, default: false } }, { timestamps: true }));
const change = new mongoose.Schema({ account: objectid, sequence: Number, library: objectid, kind: String, departures: [String] });
change.index({ account: 1, sequence: 1 }, { unique: true });
const Change = mongoose.model('Change', change);
const operation = new mongoose.Schema({ account: objectid, user: objectid, operation: String, fingerprint: String, result: mixed });
operation.index({ account: 1, user: 1, operation: 1 }, { unique: true });
const Operation = mongoose.model('Operation', operation);
const Conflict = mongoose.model('Conflict', new mongoose.Schema({ account: objectid, library: objectid, user: objectid, snippet: String, local: mixed, base: mixed, server: mixed, resolved: { type: Boolean, default: false } }, { timestamps: true }));

export { mongoose, User, Account, Member, Group, Ticket, SignupNotification, Library, Device, Change, Operation, Conflict, Passkey, Snippet, SnippetAsset, Migration, MigrationBackup };

// Integration credentials are independent of desktop enrollment.
export const Integration = mongoose.model('Integration', new mongoose.Schema({ account: objectid, user: objectid, name: String, kind: { type: String, enum: ['pat', 'oauth'] }, scopes: [String], hash: { type: String, select: false }, expires: Date, revoked: { type: Boolean, default: false }, last_used: Date, client: String, resource: String, refresh: { type: String, select: false }, refresh_expires: Date }, { timestamps: true }));
export const OAuthClient = mongoose.model('OAuthClient', new mongoose.Schema({ client_id: { type: String, unique: true }, name: String, redirects: [String] }));
export const IntegrationToken = mongoose.model('IntegrationToken', new mongoose.Schema({ hash: { type: String, unique: true }, grant: objectid, resource: String, expires: Date }, { timestamps: true }));
export const ApiAudit = mongoose.model('ApiAudit', new mongoose.Schema({ account: objectid, user: objectid, credential: objectid, operation: String, status: Number, expires: { type: Date, expires: 0 } }, { timestamps: true }));
export const SystemSetting = mongoose.model('SystemSetting', new mongoose.Schema({ key: { type: String, unique: true }, value: mixed, revision: { type: Number, default: 0 } }, { timestamps: true }));
export const AdminAudit = mongoose.model('AdminAudit', new mongoose.Schema({ account: objectid, actor: String, operation: String, status: Number }, { timestamps: true }));
export const AccountLease = mongoose.model('AccountLease', new mongoose.Schema({ account: { type: objectid, index: true }, token: { type: String, unique: true }, expires: { type: Date, expires: 0 } }));
for (const model of [Group, Ticket, Library, Device, Conflict, ApiAudit, AdminAudit]) model.schema.index({ account: 1 });
IntegrationToken.schema.index({ expires: 1 }, { expireAfterSeconds: 0 });
Ticket.schema.index({ expires: 1 }, { expireAfterSeconds: 0 });
Integration.schema.index({ hash: 1 }, { unique: true, sparse: true });
Integration.schema.index({ refresh: 1 }, { unique: true, sparse: true });
Integration.schema.index({ account: 1, user: 1 });

const productUpdateSchema = new mongoose.Schema(
	{
		ghost_id: { type: String, required: true, unique: true, trim: true },
		title: { type: String, required: true, trim: true },
		excerpt: { type: String, default: '' },
		slug: { type: String, required: true, trim: true },
		link: { type: String, required: true, trim: true },
		feature_image: { type: String, default: '' },
		published_at: { type: Date, required: true },
		show_modal: { type: Boolean, default: false },
		active: { type: Boolean, default: true },
	},
	{ timestamps: true, collection: 'product_updates' },
);

productUpdateSchema.index({ active: 1, published_at: -1, _id: -1 });
productUpdateSchema.index({ active: 1, show_modal: 1, published_at: -1, _id: -1 });

export const ProductUpdate = mongoose.model('ProductUpdate', productUpdateSchema);
