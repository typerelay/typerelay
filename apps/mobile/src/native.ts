import { registerPlugin } from '@capacitor/core';
import { Preview } from './preview';
interface NativeBridge { execute(options: { request: string }): Promise<{ data: any }>; copy(options: { text: string; html?: string; rtf?: string }): Promise<void>; keyboardSettings(): Promise<void> }
export class Native {
 static plugin = registerPlugin<NativeBridge>('TypeRelay', Preview.enabled ? { web: async () => new Preview() } : {});
 static async call(action: string, values: Record<string, unknown> = {}) { const response = await Native.plugin.execute({ request: JSON.stringify({ ...values, action }) }); return response.data; }
}
