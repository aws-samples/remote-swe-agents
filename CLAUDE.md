# Agent-Core Export Paths

agent-coreパッケージは、以下のパスでモジュールをエクスポートしています。これらのパスを使用してimportする必要があります：

## package.jsonで定義されているエクスポートパス

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./lib": {
      "types": "./dist/lib/index.d.ts",
      "default": "./dist/lib/index.js"
    },
    "./aws": {
      "types": "./dist/lib/aws/index.d.ts",
      "default": "./dist/lib/aws/index.js"
    },
    "./schema": {
      "types": "./dist/schema/index.d.ts",
      "default": "./dist/schema/index.js"
    },
    "./tools": {
      "types": "./dist/tools/index.d.ts",
      "default": "./dist/tools/index.js"
    },
    "./env": {
      "types": "./dist/env.d.ts",
      "default": "./dist/env.js"
    }
  }
}
```

## 使用例

agent-coreから関数やタイプをインポートする際は、必ずこれらの定義されたエクスポートパスを使用してください：

```typescript
// 正しい使用例
import { getSession } from '@remote-swe-agents/agent-core/lib';
import { TodoList } from '@remote-swe-agents/agent-core/schema';

// 誤った使用例 - 直接内部パスを指定しない
// import { getTodoList } from '@remote-swe-agents/agent-core/lib/todo'; // ❌
// import { TodoList } from '@remote-swe-agents/agent-core/schema/todo'; // ❌
```

定義されていないパスからのインポートは、TypeScriptのコンパイルエラーや実行時エラーを引き起こす可能性があります。