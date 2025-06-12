export interface ApiKeyItem {
  PK: 'api-key';
  SK: string; // API key string (32 bytes hex encoded)
  LSI1: string; // createdAt timestamp formatted for sorting
  createdAt: number;
  description?: string;
  ownerId?: string;
}
