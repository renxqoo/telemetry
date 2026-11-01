# Independent OTLP fixtures

`golden.json` and `values.json` are manually authored OTLP JSON vectors, based on TRACES-SPEC sections 3.2/3.4. IDs are hex and enums are numbers. They are not generated from a production adapter or from generic ProtoJSON output.

`golden.textproto` and `values.textproto` are independent protobuf text inputs using the pinned upstream definitions. grpcio-tools 1.78.0 compiles these definitions into Python modules; Python protobuf text_format parses the text and SerializeToString writes `.bin`. The toolchain is used only to generate fixtures, not at runtime or by application tests. Provenance records the source commit, tool version, input/output checksums, and independently expected fields.

Reproduction: install grpcio-tools 1.78.0 in an isolated environment; use `python -m grpc_tools.protoc --proto_path=packages/protocol/proto --python_out=<temporary-directory>` with common/resource/trace/trace_service `.proto` files. Set PYTHONPATH to that directory and use `text_format.Parse` into ExportTraceServiceRequest, then SerializeToString. Do not derive JSON fixtures using the generated Python module.

The checked-in vectors permit CI to validate interoperability without downloading compilers. Protocol source checksums and licenses live in `packages/protocol/proto/sources.json`. Schema generation during the build validates those checksums and regenerates the protobufjs descriptor locally.
