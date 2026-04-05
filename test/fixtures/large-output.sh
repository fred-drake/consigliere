#!/bin/bash
# Produce more than 1MB of output
for i in $(seq 1 20000); do
  echo "This is a line of output that is reasonably long to generate lots of data quickly line number $i"
done
