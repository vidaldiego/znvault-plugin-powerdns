import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import type { PowerDNSVaultConfig } from './vault-config.js';

export type PowerDNSMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface PowerDNSResponse<T = unknown> {
  status: number;
  contentType: string;
  data: T;
}

export class PowerDNSRequestError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'PowerDNSRequestError';
  }
}

function requestBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  try {
    return JSON.stringify(body);
  } catch {
    throw new Error('PowerDNS request body is not JSON serializable');
  }
}

function responseData(raw: Buffer, contentType: string): unknown {
  if (raw.length === 0) return null;
  const text = raw.toString('utf8');
  const firstCharacter = text.trimStart()[0];
  if (contentType.includes('json') || firstCharacter === '[' || firstCharacter === '{') {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PowerDNSRequestError('PowerDNS returned malformed JSON');
    }
  }
  return text;
}

function normalizePath(base: URL, input: string): URL {
  const trimmed = input.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(trimmed) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmed)
  ) {
    throw new Error('PowerDNS API path must be a relative path on the configured endpoint');
  }

  const basePath = base.pathname.replace(/\/+$/u, '');
  let relative = trimmed;
  if (relative === basePath) relative = '';
  else if (relative.startsWith(`${basePath}/`)) relative = relative.slice(basePath.length + 1);
  else relative = relative.replace(/^\/+/, '');

  const target = new URL(relative, `${base.toString().replace(/\/+$/u, '')}/`);
  if (
    target.origin !== base.origin ||
    (target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`))
  ) {
    throw new Error('PowerDNS API path escaped the configured API base path');
  }
  return target;
}

function statusMessage(method: PowerDNSMethod, target: URL, status: number): string {
  return `PowerDNS request ${method} ${target.pathname} failed with HTTP ${status}`;
}

export class PowerDNSClient {
  private readonly baseUrl: URL;

  public constructor(private readonly config: PowerDNSVaultConfig) {
    this.baseUrl = new URL(config.apiUrl);
  }

  public get serverId(): string {
    return this.config.serverId;
  }

  public async request<T = unknown>(
    method: PowerDNSMethod,
    path: string,
    body?: unknown,
  ): Promise<PowerDNSResponse<T>> {
    const target = normalizePath(this.baseUrl, path);
    const serialized = requestBody(body);
    const headers: Record<string, string | number> = {
      Accept: 'application/json',
      'User-Agent': 'znvault-plugin-powerdns',
      'X-API-Key': this.config.apiKey,
    };
    if (serialized !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(serialized);
    }

    const options: RequestOptions = {
      method,
      headers,
      timeout: this.config.timeoutMs,
    };
    if (target.protocol === 'https:') {
      options.rejectUnauthorized = this.config.tls.rejectUnauthorized;
      if (this.config.tls.ca !== undefined) options.ca = this.config.tls.ca;
    }

    const transport = target.protocol === 'https:' ? requestHttps : requestHttp;
    return await new Promise<PowerDNSResponse<T>>((resolve, reject) => {
      const request = transport(target, options, (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buffer.length;
          if (received > this.config.maxResponseBytes) {
            response.destroy(new PowerDNSRequestError('PowerDNS response exceeded the configured size limit'));
            return;
          }
          chunks.push(buffer);
        });
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          const contentType: string = response.headersDistinct['content-type']?.[0] ?? '';

          if (status >= 300 && status < 400) {
            reject(new PowerDNSRequestError('PowerDNS redirects are not allowed', status));
            return;
          }
          if (status < 200 || status >= 300) {
            reject(new PowerDNSRequestError(statusMessage(method, target, status), status));
            return;
          }
          try {
            resolve({
              status,
              contentType,
              data: responseData(Buffer.concat(chunks), contentType) as T,
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error('PowerDNS response processing failed'));
          }
        });
      });

      request.on('timeout', () => {
        request.destroy(new PowerDNSRequestError('PowerDNS request timed out'));
      });
      request.on('error', (error) => {
        if (error instanceof PowerDNSRequestError) reject(error);
        else reject(new PowerDNSRequestError(`PowerDNS connection failed: ${error.message}`));
      });
      if (serialized !== undefined) request.write(serialized);
      request.end();
    });
  }

  public async get<T = unknown>(path: string): Promise<T> {
    return (await this.request<T>('GET', path)).data;
  }

  public async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return (await this.request<T>('POST', path, body)).data;
  }

  public async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return (await this.request<T>('PUT', path, body)).data;
  }

  public async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return (await this.request<T>('PATCH', path, body)).data;
  }

  public async delete<T = unknown>(path: string): Promise<T> {
    return (await this.request<T>('DELETE', path)).data;
  }
}

export function encodePathSegment(value: string): string {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('PowerDNS path value is invalid');
  }
  return encodeURIComponent(value);
}

export function serverPath(client: PowerDNSClient, suffix = ''): string {
  const root = `/servers/${encodePathSegment(client.serverId)}`;
  return suffix.length === 0 ? root : `${root}/${suffix.replace(/^\/+/, '')}`;
}
