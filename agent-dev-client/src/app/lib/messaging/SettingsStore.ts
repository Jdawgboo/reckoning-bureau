import { makeAutoObservable } from 'mobx';

import { trpc } from '@/app/lib/trpc';
import type { AgentSettings } from '@/app/lib/types';
import type { MemoryStore } from './MemoryStore';

export class SettingsStore {
  agentId: string | null = null;
  loading: boolean = false;
  error: string | null = null;

  private readonly memoryStore: MemoryStore;

  constructor(memoryStore: MemoryStore) {
    this.memoryStore = memoryStore;
    makeAutoObservable<this, 'memoryStore'>(this, { memoryStore: false }, { autoBind: true });
  }

  async load() {
    if (this.loading) {
      return;
    }

    this.loading = true;
    this.error = null;

    try {
      const settings: AgentSettings = await trpc.platform.settings.query();
      this.agentId = settings.agentId;

      if (settings.agentId) {
        this.memoryStore.initialize(settings.agentId);
      }
    } catch (error: any) {
      console.error('Failed to load agent settings:', error);
      this.error = error?.message || 'Failed to load settings';
    } finally {
      this.loading = false;
    }
  }
}
