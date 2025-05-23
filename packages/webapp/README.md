This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Project Structure

```
webapp/
├── src/
│   ├── actions/         # Server actions
│   │   └── schemas/     # Zod validation schemas
│   ├── app/             # App router pages
│   ├── components/      # React components
│   ├── hooks/           # Custom React hooks
│   └── lib/             # Utility functions and configurations
├── prisma/              # Prisma schema and migrations
└── public/              # Static assets
```


## How to expand the project

### Pages

To add new pages to the application:

1. Create a new directory under `src/app` with the desired route name
2. Add a `page.tsx` file inside this directory
3. For protected pages, use the authentication session:

```tsx
import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function NewPage() {
  const session = await getSession();
  
  if (!session?.user) {
    redirect('/api/auth/signin');
  }
  
  // Your page content here
}
```

### Server Actions

This project uses type-safe server actions with authentication:

1. Define input schemas in `src/actions/schemas`:
   ```typescript
   // src/actions/schemas/example.ts
   import { z } from 'zod';
   
   export const exampleActionSchema = z.object({
     field1: z.string().min(1, "Field is required"),
     field2: z.number().optional(),
   });
   ```

2. Create server actions in `src/actions`:
   ```typescript
   // src/actions/example.ts
   'use server';
   
   import { authActionClient } from '@/lib/safe-action';
   import { exampleActionSchema } from './schemas/example';
   import { prisma } from '@/lib/prisma';
   import { revalidatePath } from 'next/cache';
   
   export const exampleAction = authActionClient.schema(exampleActionSchema).action(
     async ({ parsedInput, ctx }) => {
       const { field1, field2 } = parsedInput;
       const { userId } = ctx;
       
       // Perform database operations or other logic
       const result = await prisma.example.create({
         data: {
           field1,
           field2,
           userId,
         },
       });
       
       // Revalidate the page to refresh data
       revalidatePath('/');
       return { result };
     }
   );
   ```

3. Use server actions in client components:

   a. With React Hook Form:
   ```tsx
   'use client';
   
   import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
   import { zodResolver } from '@hookform/resolvers/zod';
   import { exampleAction } from '@/actions/example';
   import { exampleActionSchema } from '@/actions/schemas/example';
   import { toast } from 'sonner';
   
   export default function ExampleForm() {
     const {
       form: { register, formState },
       action,
       handleSubmitWithAction,
     } = useHookFormAction(exampleAction, zodResolver(exampleActionSchema), {
       actionProps: {
         onSuccess: () => {
           toast.success("Action completed successfully");
         },
         onError: ({ error }) => {
           toast.error(typeof error === 'string' ? error : "An error occurred");
         },
       },
       formProps: {
         defaultValues: {
           field1: '',
           field2: 0,
         },
       },
     });
     
     return (
       <form onSubmit={handleSubmitWithAction}>
         {/* Form fields */}
         <input {...register("field1")} />
         {formState.errors.field1 && (
           <p className="text-red-500">{formState.errors.field1.message}</p>
         )}
         <button type="submit" disabled={action.isExecuting}>
           {action.isExecuting ? 'Submitting...' : 'Submit'}
         </button>
       </form>
     );
   }
   ```

   b. For simple actions without forms:
   ```tsx
   'use client';
   
   import { useAction } from 'next-safe-action/hooks';
   import { simpleAction } from '@/actions/example';
   import { toast } from 'sonner';
   
   export default function ExampleButton() {
     const { execute, status } = useAction(simpleAction, {
       onSuccess: () => {
         toast.success("Action completed successfully");
       },
       onError: (error) => {
         toast.error(typeof error === 'string' ? error : "An error occurred");
       },
     });
     
     return (
       <button 
         onClick={() => execute({ id: '123' })}
         disabled={status === 'executing'}
       >
         {status === 'executing' ? 'Processing...' : 'Execute Action'}
       </button>
     );
   }
   ```
