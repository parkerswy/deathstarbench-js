FROM ubuntu:22.04 as builder

WORKDIR /workspace

RUN sed -i 's|http://us.archive.ubuntu.com/ubuntu|http://archive.ubuntu.com/ubuntu|g' /etc/apt/sources.list && \
    apt-get update -o Acquire::ForceIPv4=true -o Acquire::Retries=5 -o Acquire::http::Timeout=30 && \
    apt-get install -y --no-install-recommends \
      -o Acquire::ForceIPv4=true \
      -o Acquire::Retries=5 \
      -o Acquire::http::Timeout=30 \
      libssl-dev libz-dev luarocks make && \
    rm -rf /var/lib/apt/lists/* && \
    luarocks install luasocket

COPY src/ src/
COPY deps/ deps/
COPY Makefile Makefile

RUN make && make install

FROM ubuntu:22.04

COPY --from=builder /usr/local/bin/wrk /usr/local/bin/wrk
COPY --from=builder /usr/local/lib/lua /usr/local/lib/lua
COPY --from=builder /usr/local/lib/luarocks /usr/local/lib/luarocks
COPY --from=builder /usr/local/share/lua /usr/local/share/lua

CMD ["/bin/bash"]
