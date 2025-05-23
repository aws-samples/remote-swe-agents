FROM public.ecr.aws/lambda/nodejs:22 AS builder
WORKDIR /build
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY ./ ./
RUN npx esbuild src/jobs/*.ts --bundle --outdir=dist --platform=node --charset=utf8

FROM public.ecr.aws/lambda/nodejs:22 AS runner

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY --from=builder /build/dist/. ./

CMD ["async-job-runner.handler"]
