## Review your connected devices

List devices when an integration needs to show the machines connected by the authenticated user. This is a user-specific inventory, not a list of every machine belonging to every team member. The endpoint requires `devices:read`, which is separate from the content-reading scope used for snippets.

Each page contains `items` and `next_cursor`. Device records include an ID, name and creation timestamp. Show the name for recognition but retain the ID for any subsequent action. A readable device name is not a unique identifier and should not be used as the target of a revocation request.

## Present the full inventory

Request additional pages using the returned cursor until no next cursor remains. Keep the same account context while paging. If a user is reviewing old connections, show enough record information to distinguish similarly named machines before offering an action.

Revoking a device is a separate write operation with its own permission requirements. Do not turn a read-only inventory call into automatic cleanup. Read [accounts and sign-in](/guide/accounts) and [desktop sync](/desktop/sync) for the relationship between account connections and local content. For API credential setup, consult [authentication](/api/authentication); device access and API token management are related security tasks but are not the same endpoint.
