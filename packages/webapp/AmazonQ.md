## How to add Server Action
* webapp/src/actions/schemas に入力のZodスキーマを定義する
    * これはクライアント側とサーバー側双方で共有される
* webapp/src/actionsに Server Actionを定義する
    * `import { authActionClient } from '@/lib/safe-action';` を使うことで、必ず認証をかけること

## Next.js Server Component & Server Action ベストプラクティス

このドキュメントは、Next.jsを使用する際の Server Component と Server Action に関するベストプラクティスをまとめたものです。

### Server Component

#### 基本原則

1. **ページコンポーネントは async function として定義する**
   ```typescript
   // 良い例
   export default async function MyPage() {
     const data = await fetchData(); // サーバー側でデータを取得
     return <div>{data.title}</div>;
   }
   ```

2. **初回レンダリングには Server Action を使わない**
   - 初回レンダリング時のデータ取得は、Server Componentで直接データを取得する
   - Server Actionは、主にユーザーインタラクション後のデータ更新に使用する

   ```typescript
   // 良い例 - Server Componentで直接データ取得
   export default async function MyPage() {
     // Server Componentで直接データベースや関数を呼び出す
     const data = await readDataFromDB();
     return <MyComponent initialData={data} />;
   }
   
   // 悪い例 - 初回レンダリングにServer Actionを使用
   export default function MyPage() {
     const { data } = useAction(getDataAction);
     // ...
   }
   ```

3. **クライアントロジックとサーバーロジックを分離する**
   - UI操作とステート管理はクライアントコンポーネントに
   - データ取得やビジネスロジックはサーバーコンポーネントに

   ```typescript
   // 親: Server Component
   export default async function ProductPage({ id }) {
     const product = await getProduct(id);
     return <ProductClientUI product={product} />;
   }
   
   // 子: Client Component
   'use client';
   export function ProductClientUI({ product }) {
     const [quantity, setQuantity] = useState(1);
     // クライアント側のインタラクションを処理
     return (
       // UI実装
     );
   }
   ```

### Server Action

#### 基本原則

1. **'use server' が付いたファイルからは Server Action のみをエクスポートする**
   - type や interface、関数などの他の項目はエクスポートしない
   - スキーマ定義などは別ファイル（schemas.ts など）に切り出す

   ```typescript
   // 良い例 - actions.ts
   'use server';
   
   import { mySchema } from './schemas'; // スキーマは別ファイル
   import { authActionClient } from '@/lib/safe-action';
   
   export const myServerAction = authActionClient
     .schema(mySchema)
     .action(async ({ parsedInput }) => {
       // 実装
     });
   ```

   ```typescript
   // 良い例 - schemas.ts
   import { z } from 'zod';
   
   export const mySchema = z.object({
     name: z.string(),
   });
   ```

2. **Server Action と共通関数の使い方**
   - 共通関数は専用のライブラリから直接インポートする
   - DB操作用の関数はラッパーを作らず、既存の共通関数を活用する

   ```typescript
   // 良い例
   'use server';
   
   import { writeData } from '@my-app/core/lib';
   import { authActionClient } from '@/lib/safe-action';
   
   export const saveDataAction = authActionClient
     .schema(saveDataSchema)
     .action(async ({ parsedInput }) => {
       // 共通関数を直接使用
       await writeData(parsedInput);
       return { success: true };
     });
   ```

3. **適切なエラーハンドリング**
   - Server Action 内でのエラーは適切にキャッチしクライアントに返す
   - エラーメッセージは具体的かつセキュリティを考慮したものにする

   ```typescript
   export const saveDataAction = authActionClient
     .schema(saveDataSchema)
     .action(async ({ parsedInput }) => {
       try {
         await writeData(parsedInput);
         return { success: true };
       } catch (error) {
         console.error('Error saving data:', error);
         throw new Error('データの保存に失敗しました');
       }
     });
   ```

### クライアント側での Server Action の使用

1. **useAction フックの正しい使い方**
   ```typescript
   'use client';
   
   import { useAction } from 'next-safe-action/hooks';
   import { saveDataAction } from '../actions';
   
   function MyForm() {
     const { execute, status, result } = useAction(saveDataAction, {
       onSuccess: (data) => {
         // 成功時の処理
         console.log(data);
       },
       onError: (error) => {
         // エラーハンドリング
         // エラーオブジェクトの正しい参照方法
         const errorMessage = error.error?.serverError || 'エラーが発生しました';
         showError(errorMessage);
       }
     });
     
     const handleSubmit = () => {
       execute({ name: 'Example' });
     };
     
     return (
       <button onClick={handleSubmit} disabled={status === 'executing'}>
         保存
       </button>
     );
   }
   ```

2. **データ取得の責任分担**
   - 初期データはサーバーコンポーネントで取得
   - 更新操作のみをクライアントコンポーネントで実行

### まとめ

- Server Component は async function として実装する
- 初回レンダリング時のデータ取得は Server Action ではなく直接関数呼び出しを使用
- `'use server'` のファイルからは Server Action のみをエクスポート
- Server Component と Client Component の責務を明確に分ける
- スキーマや型定義は別ファイルに分離する
- 共通関数やライブラリは直接インポートして使用する
