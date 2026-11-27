// Reads a schema in jaidb's Simple text (the syntax Squill uses: `-> Owner on delete cascade`,
// `pk (A, B)` and `unique (A, B)` lines for keys of several columns) and prints, as JSON on stdout, for each engine jaidb
// has: the SQL generate_schema_sql makes, what it says it left out (unmade), and the problems
// parse_schema found, then those schema_engine_problems finds of the engine's, both for the server
// sql_visualizer writes for (server_version). test/generator-compare.js builds and
// runs it; to run it by hand:
//
//   jai test/jaidb-sql.jai -import_dir ~/repos -output_path /tmp/jaidb-sql
//   /tmp/jaidb-sql/jaidb-sql schema.txt
//
// ~/repos must hold jaidb (so `#import "jaidb"` finds ~/repos/jaidb/module.jai).

db :: #import "jaidb";
#import "Basic";
#import "String";
#import "File";

main :: () {
    args := get_command_line_arguments();
    if args.count < 2 {
        print("usage: jaidb-sql <schema.txt>\n");
        exit(2);
    }
    text, ok := read_entire_file(args[1]);
    if !ok {
        print("can't read %\n", args[1]);
        exit(2);
    }

    out: String_Builder;
    append(*out, "{");
    first := true;
    for engine: enum_values_as_enum(db.engine_t) {
        schema := db.parse_schema(text, db.p_engine_name_case(engine));
        version := server_version(engine);
        statements, unmade := db.generate_schema_sql(*schema, engine, version);
        if !first  append(*out, ",");
        first = false;
        print_to_builder(*out, "\n  %: {\"name\": %, \"sql\": %, \"unmade\": [", json_string(tprint("%", engine)), json_string(db.ENGINES[engine].name), json_string(statements));
        for unmade { if it_index  append(*out, ", "); append(*out, json_string(it)); }
        append(*out, "], \"problems\": [");
        engine_problems := db.schema_engine_problems(*schema, engine, version);
        listed := 0;
        for problems: ([] db.schema_problem_t).[schema.problems, engine_problems]  for problems {
            if listed  append(*out, ", ");
            listed += 1;
            print_to_builder(*out, "{\"line\": %, \"message\": %, \"warning\": %}", it.line, json_string(it.message), ifx it.is_warning then "true" else "false");
        }
        append(*out, "]}");
    }
    append(*out, "\n}\n");
    write_string(builder_to_string(*out));
}

// The server's version sql_visualizer writes for: a current MySQL (it has JSON, and points no foreign key at what is
// no key); any other engine's not known.
server_version :: (engine: db.engine_t) -> string {
    return ifx engine == .MYSQL then "9.0" else "";
}

// The text as a JSON string, quotes and all (temp).
json_string :: (s: string) -> string {
    b: String_Builder;
    b.allocator = temp;
    append(*b, "\"");
    for byte: cast([] u8) s {
        if byte == {
            case #char "\""; append(*b, "\\\"");
            case #char "\\"; append(*b, "\\\\");
            case #char "\n"; append(*b, "\\n");
            case #char "\r"; append(*b, "\\r");
            case #char "\t"; append(*b, "\\t");
            case;
                if byte < 0x20  print_to_builder(*b, "\\u%", formatInt(byte, base = 16, minimum_digits = 4));
                else { c := byte; append(*b, string.{ 1, *c }); }
        }
    }
    append(*b, "\"");
    return builder_to_string(*b,, temp);
}
