FROM public.ecr.aws/docker/library/alpine AS builder
WORKDIR /build
COPY ./ ./
