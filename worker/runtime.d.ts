declare function fetch(input: string, init?: RequestInit): Promise<Response>;

interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

interface ResponseInit {
  status?: number;
  headers?: Record<string, string>;
}

interface Response {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

declare const Response: {
  new (body?: string | null, init?: ResponseInit): Response;
  json(data: unknown, init?: ResponseInit): Response;
};

declare class Request {
  constructor(input: string, init?: RequestInit);
  readonly method: string;
  readonly url: string;
  text(): Promise<string>;
}

declare class URL {
  constructor(url: string, base?: string);
  readonly pathname: string;
  readonly searchParams: { get(name: string): string | null };
}
