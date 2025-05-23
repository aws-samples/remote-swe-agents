import { Handler } from 'aws-lambda';
import { z } from 'zod';

const jobPayloadPropsSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('example'),
  }),
]);

export type JobPayloadProps = z.infer<typeof jobPayloadPropsSchema>;

export const handler: Handler<unknown> = async (event, context) => {
  const { data: payload, error } = jobPayloadPropsSchema.safeParse(event);
  if (error) {
    console.log(error);
    throw new Error(error.toString());
  }

  switch (payload.type) {
    case 'example':
      console.log('example job processed');
      break;
  }
};
