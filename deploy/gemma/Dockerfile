FROM ollama/ollama:0.35.1

COPY entrypoint.sh /usr/local/bin/betweenus-gemma-entrypoint
RUN chmod 755 /usr/local/bin/betweenus-gemma-entrypoint

ENTRYPOINT ["/usr/local/bin/betweenus-gemma-entrypoint"]
