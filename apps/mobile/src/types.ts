export type Content = { version: number; type: string; text?: string; markdown?: string; language?: string; variables?: Record<string, any>; assets?: string[] };
export type Snippet = { id: string; title: string; trigger: string; revision: number; content: Content };
export type Library = { _id: string; name: string; editor_revision: number; permissions: { read: boolean; edit: boolean }; records: Snippet[] };
export type State = { mobile_bridge_version?: number; generation: string; libraries: Library[]; pending: number; conflicts: any[]; draft?: any; last_failure?: string };
export type Tokens = { access_token: string; refresh_token: string; expires_in: number; obtained_at: number; account: string; device: string };
