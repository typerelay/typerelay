// Adapted from Mailtwine's transactional email defaults (AGPL-3.0).
export const emailTemplates = {
	login: {
		name: 'Sign in',
		subject: 'Sign in to Type Relay',
		html: '<p>Click the link below to sign in to your Type Relay account:</p>\n<p><a href="{{url}}">Sign in to Type Relay</a></p>\n<p>This link expires in 15 minutes and can only be used once. If you did not request this link, you can safely ignore this email.</p>',
		variables: ['url'],
	},
	signup: {
		name: 'Verify signup',
		subject: 'Confirm your Type Relay account',
		html: '<p>Hi {{name}},</p>\n<p>Thanks for signing up for Type Relay! Please confirm your email address to start creating and syncing your snippets:</p>\n<p><a href="{{url}}">Confirm your account</a></p>\n<p>This link expires in 15 minutes and can only be used once. If you did not create an account, you can safely ignore this email.</p>',
		variables: ['name', 'url'],
	},
	'email-change': {
		name: 'Verify email change',
		subject: 'Confirm your Type Relay email address',
		html: '<p>Hi {{name}},</p>\n<p>We received a request to change the email address for your Type Relay account. Please confirm this new email address using the link below:</p>\n<p><a href="{{url}}">Confirm your email address</a></p>\n<p>You must be signed in to Type Relay to confirm the change. This link expires in 15 minutes and can only be used once.</p>\n<p>If you did not request this change, you can safely ignore this email. Your current email address will remain unchanged.</p>',
		variables: ['name', 'url'],
	},
	'password-reset': {
		name: 'Password reset',
		subject: 'Reset your Type Relay password',
		html: '<p>We received a request to reset your Type Relay password.</p>\n<p>Use the link below to generate a new password for your account. You will be able to copy your new password after confirming the reset:</p>\n<p><a href="{{url}}">Reset your password</a></p>\n<p>This link expires in 15 minutes and can only be used once. If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>',
		variables: ['url'],
	},
	invite: {
		name: 'Team invitation',
		subject: '{{inviterName}} invited you to join {{tenantName}} on Type Relay',
		html: '<p>Hi {{name}},</p>\n<p>{{inviterName}} invited you to join <strong>{{tenantName}}</strong> on Type Relay to share snippets and libraries with your team.</p>\n<p><a href="{{url}}">Accept invitation</a></p>\n<p>Sign in with the email address that received this invitation. This invitation expires in 7 days.</p>\n<p>If you were not expecting this invitation, you can safely ignore this email.</p>',
		variables: ['name', 'inviterName', 'tenantName', 'url'],
	},
};
