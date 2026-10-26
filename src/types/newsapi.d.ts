// src/types/newsapi.d.ts
declare module 'newsapi' {
  interface Source {
    id: string | null;
    name: string;
  }

  interface Article {
    source: Source;
    author?: string | null;
    title: string;
    description?: string | null;
    url: string;
    urlToImage?: string | null;
    publishedAt: string;
    content?: string | null;
  }

  export interface ArticlesResult {
    status: 'ok' | 'error';
    totalResults: number;
    articles: Article[];
  }

  class NewsAPI {
    constructor(apiKey: string);
    v2: {
      everything(params: Record<string, unknown>): Promise<ArticlesResult>;
      topHeadlines(params: Record<string, unknown>): Promise<ArticlesResult>;
      sources(params: Record<string, unknown>): Promise<ArticlesResult>;
    };
  }

  export default NewsAPI;
}
