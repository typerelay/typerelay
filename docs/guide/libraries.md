# Libraries and sharing

Libraries organize snippets and define their access. Create one with **New library**, import an export, or create it locally in the TUI. Imports and first-time desktop enrollment always create private libraries.

## Private libraries

A private library is visible only to its creator. Account owners and admins cannot inspect, edit, export or synchronize another member’s private library. They can see that the person is a member, but private content is not exposed through team management.

## Share a library

Sharing requires the Team plan. Open the library and choose **Sharing and settings**, then:

1. Enable **Shared with team**.
2. Select individual members, groups, or both.
3. Choose whether assigned members may edit.
4. Save.

The creator and account owners/admins can always read, edit and manage a shared library. Assigned members can read it. They can edit its snippets only when **Assigned members may edit** is selected. Assigned editors still cannot change the library’s grants.

Setting a library to shared without assigning members or groups makes it available only to its creator and account owners/admins. Unassigned members cannot see it.

## Move and copy content

Select snippets with their checkboxes, then choose **Move** or **Trash**. Shift-click extends a selection. **Select all** applies to the visible library. A moved snippet keeps its identity and revision history but immediately inherits the destination library’s visibility and edit permissions. Both source and destination must be editable by you.

Use **Copy** on ordinary Text or Code snippets. Text and Rich text snippets with variables use **Fill and copy** so prompted values remain local. Search with `/`, Ctrl+K or Cmd+K to find library names, titles, abbreviations and expansion text across every library you can read.

## Merge libraries

Use **Merge…** under Desktop Settings → Sync, or press **M** on a library in the TUI library picker. Choose a destination and confirm once. Every active source snippet is appended to the destination in its existing order; the destination keeps its name, sharing, permissions and sync status. Destination sharing applies immediately after synchronization.

After a successful merge, the source library moves to Trash for 30 days. Local-only libraries can merge into local-only or synchronized destinations. Synchronized libraries can merge only into another synchronized library; upload a local-only destination first. A queued merge locks source edits until it succeeds or fails, and network retries never discard the source.

## Rename, unshare or remove

The creator and account owners/admins can rename or move a shared library to Trash. Disabling sharing removes member and group access on the next sync. When Team features are unavailable after a plan change, saving a previously shared library removes its stored sharing grants.

See [Teams and roles](./teams) for account permissions and [Sync and offline use](./sync) for what happens on connected devices after access changes.
