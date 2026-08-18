export interface Envelope { id: string; ts: number; accountId: string; ip: string; payload: unknown }

export const EnvelopeSchema = {
  safeParse(raw: any) {
    if (!raw || typeof raw.id !== 'string') {
      return { success: false as const, error: { message: 'missing id' } };
    }
    return { success: true as const, data: raw as Envelope };
  },
};

export async function lookupGeo(_ip: string): Promise<string> { return 'unknown'; }
export async function lookupOrg(_account: string): Promise<string> { return 'unknown'; }
