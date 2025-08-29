## Next.js Server Components & Server Actions (Webapp)

### Server Component Best Practices

1. **Define page components as async functions**
   ```typescript
   // Good example
   export default async function MyPage() {
     const data = await fetchData(); // Fetch data on the server
     return <div>{data.title}</div>;
   }
   ```

2. **Don't use Server Actions for initial rendering**
   - For initial rendering, fetch data directly in the Server Component
   - Use Server Actions primarily for data updates after user interactions

   ```typescript
   // Good example - Direct data fetching in Server Component
   export default async function MyPage() {
     // Directly call database functions in Server Component
     const data = await readDataFromDB();
     return <MyComponent initialData={data} />;
   }
   
   // Bad example - Using Server Action for initial rendering
   export default function MyPage() {
     const { data } = useAction(getDataAction);
     // ...
   }
   ```

3. **Separate client logic from server logic**
   - Keep UI operations and state management in client components
   - Keep data fetching and business logic in server components

   ```typescript
   // Parent: Server Component
   export default async function ProductPage({ id }) {
     const product = await getProduct(id);
     return <ProductClientUI product={product} />;
   }
   
   // Child: Client Component
   'use client';
   export function ProductClientUI({ product }) {
     const [quantity, setQuantity] = useState(1);
     // Handle client-side interactions
     return (
       // UI implementation
     );
   }
   ```

### Server Actions Pattern

When implementing server-side functionality in the webapp, always use Next.js server actions instead of API Routes:

1. **Server Action Creation Pattern**:
   ```typescript
   'use server';
   
   import { authActionClient } from '@/lib/safe-action';
   import { myActionSchema } from './schemas';
   
   export const myServerAction = authActionClient
     .schema(myActionSchema)
     .action(async ({ parsedInput: { param1, param2 } }) => {
       // Implement server-side logic
       return result;
     });
   ```

2. **Action Schema Definition**:
   ```typescript
   // schemas.ts
   import { z } from 'zod';
   
   export const myActionSchema = z.object({
     param1: z.string(),
     param2: z.number(),
   });
   ```

3. **Only export Server Actions from files with 'use server' directive**
   - Do not export types, interfaces, or other functions
   - Move schemas and other definitions to separate files (e.g., schemas.ts)

4. **Import and use common functions directly**
   - Import common functions directly from dedicated libraries
   - Use existing common functions for DB operations rather than creating wrappers

   ```typescript
   // Good example
   'use server';
   
   import { writeData } from '@remote-swe-agents/agent-core/lib';
   import { authActionClient } from '@/lib/safe-action';
   
   export const saveDataAction = authActionClient
     .schema(saveDataSchema)
     .action(async ({ parsedInput }) => {
       // Use common function directly
       await writeData(parsedInput);
       return { success: true };
     });
   ```

5. **Client-side Usage with useAction hook**:
   ```typescript
   'use client';
   
   import { useAction } from 'next-safe-action/hooks';
   import { myServerAction } from '../actions';
   
   // In component:
   const { execute, status, result } = useAction(myServerAction, {
     onSuccess: (data) => {
       // Handle success
     },
     onError: (error) => {
       // Handle error
       const errorMessage = error.error?.serverError || 'An error occurred';
       toast(errorMessage);
     }
   });
   
   const handleSubmit = () => {
     execute({ param1: 'value', param2: 42 });
   };
   ```

### Important Notes

- **NEVER** use direct API Routes (app/api/...) when server actions can be used instead
- **ALWAYS** handle both success and error cases in client-side code
- Keep database access code in server actions, not in client components
- Use Zod schemas for validation in server actions
- When dealing with DynamoDB, import from `@remote-swe-agents/agent-core/aws` and use directly in server actions
- The auth middleware automatically protects server actions through `authActionClient`
- **Data Responsibility Distribution**:
  - Fetch initial data in server components
  - Perform update operations only in client components

## Coding Conventions

- Use TypeScript to ensure type safety
- Use Promise-based patterns for asynchronous operations
- Use Prettier for code formatting
- Prefer function-based implementations over classes
- DO NOT write code comments unless the implementation is so complicated or difficult to understand without comments.
- If writing code comments, ALWAYS USE English language.

## i18n (Internationalization)
- Whenever you add labels in the UI, use next-i18n.
    ```ts
    const t = await getTranslations('section');
    t('title')
    ```
- labels are maintained in Japanese and English. Edit src/messages/en.json and ja.json accordingly.
