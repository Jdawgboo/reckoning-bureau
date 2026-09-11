import type { FileReadingService, FileUploadService } from '@/app/lib/services';

export type AgentSettings = {
  agentId: string;
};

export interface UIServicesContainerI {
  fileReadingService: FileReadingService;
  fileUploadService: FileUploadService;
}
