---
title: "TypeRelay teams and roles"
description: "Manage TypeRelay team roles, invitations, groups, shared-library access, member changes, and plan limits without exposing private libraries."
---

# Teams and roles

Team management and library sharing require the Team plan. Open the avatar menu, choose **Settings → My team**, and confirm the correct account is selected.

## Roles

| Capability | Owner | Admin | Member |
| --- | ---: | ---: | ---: |
| Rename the account | Yes | Yes | No |
| Invite members and revoke invitations | Yes | Yes | No |
| Create and edit groups | Yes | Yes | No |
| Promote or demote admins | Yes | No | No |
| Remove a member | Yes | Yes, except admins | No |
| Manage any shared library | Yes | Yes | No |
| Read another person’s private library | No | No | No |
| Use assigned shared libraries | Yes | Yes | Yes |
| Manage subscription and white-label settings | Yes | Yes | No |

The initial account creator is its owner. The owner cannot be removed. Only the owner can promote a member to admin or demote an admin. There is currently no ownership-transfer control.

## Invite someone

Enter the person’s email address under **Invite by email**. Invitations:

- expire after seven days;
- are bound to the invited email address;
- use a Team seat while pending;
- can be revoked by an owner or admin.

The recipient opens the link, signs in with the same email address, and confirms **Join this TypeRelay team?**. A new user may complete account creation through the same verified email flow. If the team is already at its purchased capacity, increase seats under **Settings → Subscription** before inviting or accepting.

## Remove or change a member

The owner can change a member between Member and Admin. Owners and admins can remove ordinary members; admins cannot change or remove other admins. Removing a member also removes them from every group and revokes their connected devices for that account.

On the removed person’s next successful desktop sync, shared libraries they can no longer read are removed from active search and expansion. Unsent edits are retained in local recovery instead of being uploaded to a library they no longer have permission to change.

## Groups

Groups are flat collections of existing account members. Owners and admins can create, rename, change membership or delete a group. Assign a group under a library’s **Sharing and settings** to avoid maintaining the same member list on each library.

Deleting a group removes that grant. A member may retain access through a direct assignment, another group, library ownership or an account owner/admin role.

## Share safely

Library sharing is explicit. Team membership alone does not reveal private libraries or grant access to shared libraries. For each library, verify both the assignees and the **Editing** choice:

- **Creator and account admins only** gives assigned members read-only access.
- **Assigned members may edit** lets assigned members change, move and trash snippets in that library.

Moving a snippet into a shared library shares it under the destination’s rules. Moving one out requires edit access to both libraries.

## Plan changes

Team includes five prepaid seats; extra seats must be purchased before more invitations or members fit. Seat reductions and Team-to-Pro changes take effect at renewal only after active members and pending invitations fit the requested capacity.

After a downgrade from Team, non-owner memberships cannot use that account and sharing controls are disabled. Existing content is retained. Upgrade again or remove extra members and sharing grants as appropriate.
