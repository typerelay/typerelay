import mongoose from 'mongoose';
import { avatarStyles } from './avatar_styles.js';

const objectid = mongoose.Schema.Types.ObjectId;
const mixed = mongoose.Schema.Types.Mixed;
const asset = new mongoose.Schema({ url: String, storage_key: { type: String, select: false }, mime_type: String, size: Number, width: Number, height: Number, updated_at: Date }, { _id: false });
const User = mongoose.model('User', new mongoose.Schema({ deletion: { requested_at: Date, accounts: [objectid], owned_accounts: [objectid], review_accounts: [objectid], reviewed_at: Date, next_attempt_at: Date, error: String }, email: { type: String, unique: true }, name: String, avatar_style: { type: String, enum: Object.keys(avatarStyles), default: 'initials' }, password: { type: String, select: false }, totp_secret: { type: String, select: false }, totp_enabled: { type: Boolean, default: false }, totp_step: { type: Number, select: false }, auth_version: { type: Number, default: 0 }, activity_sequence: { type: Number, default: 0 }, last_login: { type: Date, default: null }, product_updates_seen_at: { type: Date, default: Date.now, select: false } }, { timestamps: true, 'read': 'secondaryPreferred' }));
const Passkey = mongoose.model('Passkey', new mongoose.Schema({ user: { type: objectid, index: true }, credential_id: { type: String, unique: true }, public_key: { type: String, select: false }, counter: Number, transports: [String], name: String }, { timestamps: true }));
const accountSchema = new mongoose.Schema({
	name: String,
	acquisition: { type: new mongoose.Schema({ gclid: String, gbraid: String, wbraid: String, utm_source: String, utm_medium: String, utm_campaign: String, utm_content: String, utm_term: String, matchtype: String, device: String, landing_path: String, transaction_id: String, confirmed_at: Date, dispatched_at: Date }, { _id: false }), select: false },
	is_active: { type: Boolean, default: true },
	admin_revision: { type: Number, default: 0 },
	activity_sequence: { type: Number, default: 0 },
	admin_override: { plan: { type: String, enum: ['free', 'pro', 'team', null], default: null }, limits: { people: { type: Number, default: null }, snippets: { type: Number, default: null }, libraries: { type: Number, default: null }, machines: { type: Number, default: null } } },
	deletion: { requested_at: Date, stage: String, error: String, users: [objectid], grants: [objectid], lease: String, lease_until: Date },
	sequence: { type: Number, default: 0 },
	sync_history_version: Number,
	sync_floor: Number,
	plan: { type: String, enum: ['free', 'pro', 'team'], default: 'free' },
	sso: {
		enabled: { type: Boolean, default: false }, enforce: { type: Boolean, default: false }, provision: { type: Boolean, default: false },
		issuer: { type: String, default: '' }, login_url: { type: String, default: '' }, certificate: { type: String, default: '', select: false },
		revision: { type: Number, default: 0 }, tested_fingerprint: { type: String, default: '' }, tested_at: Date,
		recovery_hash: { type: String, select: false }, recovery_ready: { type: Boolean, default: false },
	},
	billing: {
		revision: { type: Number, default: 0 },
		stripe_customer_id: { type: String, select: false },
		stripe_subscription_id: { type: String, select: false },
		stripe_free_subscription_id: { type: String, select: false },
		price_id: { type: String, default: '' },
		seat_quantity: { type: Number, default: 1 },
		included_seats: Number,
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
			price_id: String,
			seat_quantity: Number,
			effective_at: Date,
			schedule_id: { type: String, select: false },
			pending: { type: Boolean, default: false },
		},
		checkout: {
			session_id: { type: String, select: false },
			plan: { type: String, enum: ['pro', 'team'] },
			seat_quantity: Number,
		},
	},
	white_label: {
		logo: { type: asset, default: null },
		favicon: { type: asset, default: null },
		login_logo: { type: asset, default: null },
		hostname: { type: String, default: '' },
		state: { type: String, enum: ['unconfigured', 'pending_dns', 'pending_ssl', 'active', 'disabled_by_plan', 'error'], default: 'unconfigured' },
		cloudflare_hostname_id: { type: String, default: '', select: false },
		claim_token: { type: String, default: '', select: false },
		provider_action: { type: String, enum: ['', 'creating', 'deleting'], default: '' },
		pending_hostname: { type: String, default: null },
		operation_token: { type: String, default: '', select: false },
		operation_until: { type: Date, default: null, select: false },
		cloudflare_hostname_status: { type: String, default: '' },
		cloudflare_ssl_status: { type: String, default: '' },
		dns_verified_at: { type: Date, default: null },
		cloudflare_checked_at: { type: Date, default: null },
		next_check_at: { type: Date, default: null },
		disabled_at: { type: Date, default: null },
		last_error: { type: String, default: '' },
	},
}, { timestamps: true, 'read': 'secondaryPreferred' });
accountSchema.index({ 'white_label.hostname': 1 }, { name: 'white_label_verified_hostname', unique: true, partialFilterExpression: { 'white_label.hostname': { $type: 'string', $gt: '' }, 'white_label.dns_verified_at': { $type: 'date' } } });
accountSchema.index({ 'billing.helpmonks_sequence.status': 1, 'billing.helpmonks_sequence.next_attempt_at': 1 });
accountSchema.index({ 'deletion.requested_at': 1, 'deletion.stage': 1 });
for (const field of ['stripe_customer_id', 'stripe_subscription_id']) accountSchema.index({ ['billing.' + field]: 1 }, { sparse: true });
const Account = mongoose.model('Account', accountSchema);
const membership = new mongoose.Schema({ account: objectid, user: objectid, role: { type: String, enum: ['owner', 'admin', 'member'] } }, { 'read': 'secondaryPreferred' });
membership.index({ account: 1, user: 1 }, { unique: true });
membership.index({ user: 1 });
const Member = mongoose.model('Member', membership);
const Group = mongoose.model('Group', new mongoose.Schema({ account: objectid, name: String, users: [objectid] }, { 'read': 'secondaryPreferred' }));
const Ticket = mongoose.model('Ticket', new mongoose.Schema({ hash: { type: String, unique: true }, kind: String, email: String, account: objectid, data: mixed, expires: Date }, { 'read': 'secondaryPreferred' }));
const signupNotificationSchema = new mongoose.Schema({ account: { type: objectid, required: true, unique: true, index: true }, user: { type: objectid, required: true, index: true }, email: { type: String, required: true }, name: { type: String, default: '' }, status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending', index: true }, attempts: { type: Number, default: 0 }, next_attempt_at: { type: Date, default: null }, last_attempt_at: { type: Date, default: null }, sent_at: { type: Date, default: null }, failed_at: { type: Date, default: null }, last_error: { type: String, default: '' }, message_id: { type: String, required: true } }, { timestamps: true, 'read': 'secondaryPreferred' });
signupNotificationSchema.index({ status: 1, next_attempt_at: 1 });
const SignupNotification = mongoose.model('SignupNotification', signupNotificationSchema);
const lifecycle = { state: { type: String, enum: ['active', 'trashed', 'purged'], default: 'active' }, trashed_at: Date, trashed_by: String, expires_at: Date, purge_sequence: Number };
const Library = mongoose.model('Library', new mongoose.Schema({ account: objectid, creator: objectid, name: String, shared: Boolean, editable: Boolean, members: [objectid], groups: [objectid], purge_readers: [objectid], revision: Number, ...lifecycle }, { 'read': 'secondaryPreferred' }));
const snippetSchema = new mongoose.Schema({ account: objectid, library: objectid, id: String, title: String, trigger: String, content: mixed, position: Number, revision: Number, ...lifecycle }, { timestamps: true, 'read': 'secondaryPreferred' });
snippetSchema.index({ library: 1, id: 1 }, { unique: true });
snippetSchema.index({ account: 1, id: 1 }, { unique: true });
snippetSchema.index({ library: 1, trigger: 1 }, { unique: true, partialFilterExpression: { state: 'active', trigger: { $type: 'string', $gt: '' } } });
snippetSchema.index({ state: 1, expires_at: 1, account: 1 });
snippetSchema.index({ account: 1, state: 1, purge_sequence: 1 });
snippetSchema.index({ account: 1, 'content.assets': 1 });
Library.schema.index({ state: 1, expires_at: 1, account: 1 });
Library.schema.index({ account: 1, state: 1, purge_sequence: 1 });
const Snippet = mongoose.model('Snippet', snippetSchema);
const personalAbbreviationSchema = new mongoose.Schema({ account: { type: objectid, required: true }, user: { type: objectid, required: true }, snippet: { type: String, required: true }, trigger: { type: String, default: null }, revision: { type: Number, default: 0 }, conflicts: { type: [mixed], default: [] } }, { timestamps: true, 'read': 'secondaryPreferred' });
personalAbbreviationSchema.index({ account: 1, user: 1, snippet: 1 }, { unique: true });
export const PersonalAbbreviation = mongoose.model('PersonalAbbreviation', personalAbbreviationSchema);
const snippetAssetSchema = new mongoose.Schema({ account: objectid, id: String, data: { type: Buffer, select: false }, mime_type: String, size: Number, width: Number, height: Number, animated: Boolean, source_urls: [String], staged_by: [objectid], last_referenced_at: Date }, { timestamps: true, 'read': 'secondaryPreferred' });
snippetAssetSchema.index({ account: 1, id: 1 }, { unique: true });
snippetAssetSchema.index({ account: 1, size: 1 });
snippetAssetSchema.index({ updatedAt: 1, account: 1 });
const SnippetAsset = mongoose.model('SnippetAsset', snippetAssetSchema);
const Migration = mongoose.model('Migration', new mongoose.Schema({ key: { type: String, unique: true }, completed: Boolean }, { 'read': 'secondaryPreferred' }));
const MigrationBackup = mongoose.model('MigrationBackup', new mongoose.Schema({ key: { type: String, unique: true }, source_collection: String, payload: mixed }, { 'read': 'secondaryPreferred' }));
const Device = mongoose.model('Device', new mongoose.Schema({ account: objectid, user: objectid, name: String, oauth_client: { type: String, enum: ['typerelay-desktop', 'typerelay-mobile', 'typerelay-browser'] }, client_type: { type: String, enum: ['desktop', 'cli', 'mobile', 'browser'] }, os: { type: String, enum: ['macos', 'windows', 'linux', 'ios', 'android', 'web'] }, last_active: Date, access: String, access_expires: Date, refresh: String, refresh_expires: Date, revoked: { type: Boolean, default: false } }, { timestamps: true, 'read': 'secondaryPreferred' }));
Device.schema.add({ sso_revision: Number });
const change = new mongoose.Schema({ account: objectid, sequence: Number, library: objectid, kind: String, departures: [String] }, { 'read': 'secondaryPreferred' });
change.index({ account: 1, sequence: 1 }, { unique: true });
const Change = mongoose.model('Change', change);
const operation = new mongoose.Schema({ account: objectid, user: objectid, operation: String, fingerprint: String, result: mixed, expires: Date }, { 'read': 'secondaryPreferred' });
operation.index({ account: 1, user: 1, operation: 1 }, { unique: true });
operation.index({ expires: 1 }, { expireAfterSeconds: 0 });
const Operation = mongoose.model('Operation', operation);
const Conflict = mongoose.model('Conflict', new mongoose.Schema({ account: objectid, library: objectid, user: objectid, snippet: String, local: mixed, base: mixed, server: mixed, resolved: { type: Boolean, default: false } }, { timestamps: true, 'read': 'secondaryPreferred' }));

export { mongoose, User, Account, Member, Group, Ticket, SignupNotification, Library, Device, Change, Operation, Conflict, Passkey, Snippet, SnippetAsset, Migration, MigrationBackup };

// Integration credentials are independent of desktop enrollment.
export const Integration = mongoose.model('Integration', new mongoose.Schema({ account: objectid, user: objectid, name: String, kind: { type: String, enum: ['pat', 'oauth'] }, scopes: [String], hash: { type: String, select: false }, expires: Date, revoked: { type: Boolean, default: false }, last_used: Date, client: String, resource: String, refresh: { type: String, select: false }, refresh_expires: Date }, { timestamps: true, 'read': 'secondaryPreferred' }));
Integration.schema.add({ sso_revision: Number });
export const SsoLog = mongoose.model('SsoLog', new mongoose.Schema({ account: { type: objectid, index: true }, user: objectid, event: String, expires: { type: Date, expires: 0 } }, { timestamps: true, 'read': 'secondaryPreferred' }));
export const OAuthClient = mongoose.model('OAuthClient', new mongoose.Schema({ account: objectid, created_by: objectid, client_id: { type: String, unique: true }, name: String, client_uri: String, redirects: [String], registration_source: { type: String, enum: ['dynamic', 'manual'], default: 'dynamic' }, token_endpoint_auth_method: { type: String, enum: ['none', 'client_secret_post'], default: 'none' }, secret_hash: { type: String, select: false } }, { timestamps: true, 'read': 'secondaryPreferred' }));
export const IntegrationToken = mongoose.model('IntegrationToken', new mongoose.Schema({ hash: { type: String, unique: true }, grant: objectid, resource: String, expires: Date }, { timestamps: true, 'read': 'secondaryPreferred' }));
export const ApiAudit = mongoose.model('ApiAudit', new mongoose.Schema({ account: objectid, user: objectid, credential: objectid, operation: String, status: Number, expires: { type: Date, expires: 0 } }, { timestamps: true, 'read': 'secondaryPreferred' }));
export const SystemSetting = mongoose.model('SystemSetting', new mongoose.Schema({ key: { type: String, unique: true }, value: mixed, revision: { type: Number, default: 0 } }, { timestamps: true, 'read': 'secondaryPreferred' }));
export const AdminAudit = mongoose.model('AdminAudit', new mongoose.Schema({ account: objectid, actor: String, operation: String, status: Number }, { timestamps: true, 'read': 'secondaryPreferred' }));
export const AccountLease = mongoose.model('AccountLease', new mongoose.Schema({ account: { type: objectid, index: true }, token: { type: String, unique: true }, expires: { type: Date, expires: 0 } }, { 'read': 'secondaryPreferred' }));
for (const model of [Group, Ticket, Device, ApiAudit, AdminAudit]) model.schema.index({ account: 1 });
Conflict.schema.index({ account: 1, library: 1 });
for (const field of ['access', 'refresh']) Device.schema.index({ [field]: 1 }, { sparse: true });
IntegrationToken.schema.index({ expires: 1 }, { expireAfterSeconds: 0 });
Ticket.schema.index({ expires: 1 }, { expireAfterSeconds: 0 });
Integration.schema.index({ hash: 1 }, { unique: true, sparse: true });
Integration.schema.index({ refresh: 1 }, { unique: true, sparse: true });
Integration.schema.index({ account: 1, user: 1 });
OAuthClient.schema.index({ account: 1, registration_source: 1 });

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
	{ timestamps: true, collection: 'product_updates', 'read': 'secondaryPreferred' },
);

productUpdateSchema.index({ active: 1, published_at: -1, _id: -1 });
productUpdateSchema.index({ active: 1, show_modal: 1, published_at: -1, _id: -1 });

export const ProductUpdate = mongoose.model('ProductUpdate', productUpdateSchema);

const usageEventSchema = new mongoose.Schema({ account: { type: objectid, required: true }, user: { type: objectid, required: true }, event_id: { type: String, required: true }, library: { type: objectid, required: true }, snippet: { type: String, required: true }, action: { type: String, enum: ['copy', 'insert'], required: true }, client: String, occurred_at: { type: Date, required: true }, characters: { type: Number, required: true }, shared: Boolean }, { timestamps: true, 'read': 'secondaryPreferred' });
usageEventSchema.index({ account: 1, user: 1, event_id: 1 }, { unique: true });
usageEventSchema.index({ account: 1, user: 1, occurred_at: 1 });
usageEventSchema.index({ account: 1, shared: 1, occurred_at: 1 });
export const UsageEvent = mongoose.model('UsageEvent', usageEventSchema);
const statisticsPreferenceSchema = new mongoose.Schema({ account: { type: objectid, required: true }, user: { type: objectid, default: null }, wpm: { type: Number, default: 50 }, hourly_rate: { type: Number, default: 30 }, currency: { type: String, default: 'USD' } }, { 'read': 'secondaryPreferred' });
statisticsPreferenceSchema.index({ account: 1, user: 1 }, { unique: true });
export const StatisticsPreference = mongoose.model('StatisticsPreference', statisticsPreferenceSchema);

const aiSettingSchema = new mongoose.Schema({ use_managed: { type: Boolean, default: false }, account: { type: objectid, required: true }, user: { type: objectid, default: null }, enabled: { type: Boolean, default: true }, connections: { type: [mixed], default: [], select: false }, routes: { type: mixed, default: {} }, revision: { type: Number, default: 0 } }, { timestamps: true, 'read': 'secondaryPreferred' });
aiSettingSchema.index({ account: 1, user: 1 }, { unique: true });
export const AiSetting = mongoose.model('AiSetting', aiSettingSchema);
const aiUsageSchema = new mongoose.Schema({ account: { type: objectid, required: true }, user: { type: objectid, required: true }, day: { type: String, required: true }, count: { type: Number, default: 0 }, expires: { type: Date, expires: 0 } });
aiUsageSchema.index({ account: 1, user: 1, day: 1 }, { unique: true });
export const AiUsage = mongoose.model('AiUsage', aiUsageSchema);
const aiRequestSchema = new mongoose.Schema({ account: { type: objectid, required: true }, user: { type: objectid, required: true }, id: { type: String, required: true }, workflow: String, managed: Boolean, day: String, state: String, expires: { type: Date, expires: 0 } });
aiRequestSchema.index({ account: 1, user: 1, id: 1 }, { unique: true });
export const AiRequest = mongoose.model('AiRequest', aiRequestSchema);
