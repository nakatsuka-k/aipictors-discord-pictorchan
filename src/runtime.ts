// Worker のバインディング（Durable Object の起動時に入れる）
export type Bindings = {
  STATE: R2Bucket;
  IMAGES?: ImagesBinding;
  MEDIA?: any;
};

export const runtime: { env: Bindings | null } = { env: null };

export function setRuntime(env: Bindings) {
  runtime.env = env;
}
