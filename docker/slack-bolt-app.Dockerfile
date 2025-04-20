FROM public.ecr.aws/lambda/nodejs:22 AS builder
WORKDIR /build
COPY package*.json ./
COPY packages/agent-core/package*.json ./packages/agent-core/
COPY packages/slack-bolt-app/package*.json ./packages/slack-bolt-app/
RUN npm ci
COPY ./ ./
RUN cd packages/agent-core && npm run build
RUN cd packages/slack-bolt-app && npm run bundle

FROM public.ecr.aws/lambda/nodejs:22 AS runner

COPY --from=builder /build/packages/slack-bolt-app/dist/. ./

CMD ["lambda.handler"]
