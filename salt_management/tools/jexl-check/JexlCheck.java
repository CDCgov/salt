import org.apache.commons.jexl3.JexlBuilder;
import org.apache.commons.jexl3.JexlEngine;
import org.apache.commons.jexl3.JexlException;
import org.apache.commons.jexl3.JexlFeatures;
import org.apache.commons.jexl3.JexlInfo;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parses survey JEXL scripts with the same library the SALT tablet uses
 * (commons-jexl3 3.3) and reports errors, variable names and calls.
 *
 * Protocol: one JSON request per stdin line, one JSON reply per stdout line.
 *   -> {"id":7,"scripts":[{"key":"q1.validation","src":"value <= x"}]}
 *   <- {"id":7,"results":[{"key":"q1.validation","ok":true,"vars":["value","x"],"calls":[]}]}
 * A request {"id":0,"info":true} returns the JEXL version and engine features.
 *
 * Scripts are parsed, never evaluated.
 */
public class JexlCheck {
    // Strict like the tablet, plus restrictions SALT scripts never need.
    // Keep in sync with the parity test in tests/jexlCheck.test.js.
    static final JexlFeatures FEATURES = new JexlFeatures()
        .sideEffect(false).sideEffectGlobal(false)
        .loops(false).lambda(false).newInstance(false)
        .pragma(false).annotation(false).script(false);

    static final JexlEngine ENGINE = new JexlBuilder()
        .strict(true).silent(false).features(FEATURES).create();

    // Used only to list variables after ENGINE has accepted the source:
    // getVariables() needs a script object, which script(false) forbids.
    static final JexlEngine VARS_ENGINE = new JexlBuilder()
        .strict(true).silent(false).create();

    static final Set<String> KEYWORDS = new HashSet<>(Arrays.asList(
        "not", "and", "or", "eq", "ne", "lt", "gt", "le", "ge", "div", "mod",
        "new", "function", "var", "if", "else", "return", "while", "for", "do"));
    static final Pattern CALL = Pattern.compile("(\\.\\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\\s*(:\\s*[A-Za-z_$][A-Za-z0-9_$]*\\s*)?\\(");

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintStream out = new PrintStream(System.out, true, "UTF-8");
        String line;
        while ((line = in.readLine()) != null) {
            if (line.trim().isEmpty()) continue;
            Object id = null;
            try {
                @SuppressWarnings("unchecked")
                Map<String, Object> req = (Map<String, Object>) new Json(line).value();
                id = req.get("id");
                if (Boolean.TRUE.equals(req.get("info"))) {
                    out.println(info(id));
                    continue;
                }
                StringBuilder sb = new StringBuilder("{\"id\":").append(Json.write(id)).append(",\"results\":[");
                List<?> scripts = (List<?>) req.get("scripts");
                for (int i = 0; scripts != null && i < scripts.size(); i++) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> s = (Map<String, Object>) scripts.get(i);
                    if (i > 0) sb.append(',');
                    sb.append(check(String.valueOf(s.get("key")), String.valueOf(s.get("src"))));
                }
                out.println(sb.append("]}"));
            } catch (Exception e) {
                out.println("{\"id\":" + Json.write(id) + ",\"error\":" + Json.write(String.valueOf(e.getMessage())) + "}");
            }
        }
    }

    static String info(Object id) {
        Package p = JexlEngine.class.getPackage();
        String version = p == null ? null : p.getImplementationVersion();
        return "{\"id\":" + Json.write(id) + ",\"jexlVersion\":" + Json.write(version)
            + ",\"features\":{"
            + "\"sideEffect\":" + FEATURES.supportsSideEffect()
            + ",\"sideEffectGlobal\":" + FEATURES.supportsSideEffectGlobal()
            + ",\"loops\":" + FEATURES.supportsLoops()
            + ",\"lambda\":" + FEATURES.supportsLambda()
            + ",\"newInstance\":" + FEATURES.supportsNewInstance()
            + ",\"pragma\":" + FEATURES.supportsPragma()
            + ",\"annotation\":" + FEATURES.supportsAnnotation()
            + ",\"script\":" + FEATURES.supportsScript()
            + "}}";
    }

    static String check(String key, String src) {
        StringBuilder sb = new StringBuilder("{\"key\":").append(Json.write(key));
        try {
            ENGINE.createExpression(src);
        } catch (JexlException e) {
            JexlInfo info = e.getInfo();
            sb.append(",\"ok\":false,\"error\":").append(Json.write(cleanMessage(e)));
            if (info != null) sb.append(",\"line\":").append(info.getLine()).append(",\"col\":").append(info.getColumn());
            return sb.append('}').toString();
        } catch (RuntimeException e) {
            return sb.append(",\"ok\":false,\"error\":").append(Json.write(String.valueOf(e.getMessage()))).append('}').toString();
        }
        Set<String> vars = new LinkedHashSet<>();
        for (List<String> v : VARS_ENGINE.createScript(src).getVariables()) {
            if (!v.isEmpty()) vars.add(v.get(0));
        }
        sb.append(",\"ok\":true,\"vars\":[");
        int n = 0;
        for (String v : vars) sb.append(n++ > 0 ? "," : "").append(Json.write(v));
        sb.append("],\"calls\":[");
        n = 0;
        for (String c : calls(src)) sb.append(n++ > 0 ? "," : "").append(Json.write(c));
        return sb.append("]}").toString();
    }

    /** Message without the "JexlCheck.check:NN@" location prefix JEXL adds. */
    static String cleanMessage(JexlException e) {
        String m = String.valueOf(e.getMessage());
        int at = m.indexOf(' ');
        if (at > 0 && m.substring(0, at).contains("@")) m = m.substring(at + 1);
        return m;
    }

    /**
     * Method and function calls in parsed source: ".name" for a method,
     * "name" for a function, "ns:name" for a namespace function. String
     * literals are blanked first so their contents are not scanned.
     */
    static List<String> calls(String src) {
        StringBuilder code = new StringBuilder(src);
        char quote = 0;
        for (int i = 0; i < code.length(); i++) {
            char c = code.charAt(i);
            if (quote != 0) {
                if (c == '\\' && i + 1 < code.length()) { code.setCharAt(i, ' '); code.setCharAt(++i, ' '); continue; }
                if (c == quote) { quote = 0; continue; }
                code.setCharAt(i, ' ');
            } else if (c == '\'' || c == '"' || c == '`') {
                quote = c;
            }
        }
        Set<String> found = new LinkedHashSet<>();
        Matcher m = CALL.matcher(code);
        while (m.find()) {
            String name = m.group(2);
            if (m.group(1) != null) { found.add("." + name); continue; }
            if (m.group(3) != null) { found.add(name + ":" + m.group(3).replace(":", "").trim()); continue; }
            if (!KEYWORDS.contains(name)) found.add(name);
        }
        return new ArrayList<>(found);
    }

    /** Minimal JSON reader/writer: objects, arrays, strings, numbers, booleans, null. */
    static class Json {
        final String s; int i;
        Json(String s) { this.s = s; }

        Object value() {
            ws();
            char c = s.charAt(i);
            if (c == '{') {
                Map<String, Object> m = new LinkedHashMap<>(); i++; ws();
                if (s.charAt(i) == '}') { i++; return m; }
                while (true) {
                    ws(); String k = str(); ws(); expect(':'); m.put(k, value()); ws();
                    if (s.charAt(i) == ',') { i++; continue; }
                    expect('}'); return m;
                }
            }
            if (c == '[') {
                List<Object> l = new ArrayList<>(); i++; ws();
                if (s.charAt(i) == ']') { i++; return l; }
                while (true) {
                    l.add(value()); ws();
                    if (s.charAt(i) == ',') { i++; continue; }
                    expect(']'); return l;
                }
            }
            if (c == '"') return str();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            if (start == i) throw new IllegalArgumentException("Bad JSON at " + i);
            return Double.valueOf(s.substring(start, i));
        }

        String str() {
            expect('"');
            StringBuilder b = new StringBuilder();
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') return b.toString();
                if (c != '\\') { b.append(c); continue; }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': b.append('\n'); break;
                    case 'r': b.append('\r'); break;
                    case 't': b.append('\t'); break;
                    case 'b': b.append('\b'); break;
                    case 'f': b.append('\f'); break;
                    case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                    default: b.append(e);
                }
            }
        }

        void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
        void expect(char c) {
            if (i >= s.length() || s.charAt(i) != c) throw new IllegalArgumentException("Expected '" + c + "' at " + i);
            i++;
        }

        static String write(Object o) {
            if (o == null) return "null";
            if (o instanceof Double) {
                double d = (Double) o;
                return d == Math.rint(d) ? String.valueOf((long) d) : String.valueOf(d);
            }
            if (o instanceof Number || o instanceof Boolean) return String.valueOf(o);
            String str = String.valueOf(o);
            StringBuilder b = new StringBuilder("\"");
            for (int k = 0; k < str.length(); k++) {
                char c = str.charAt(k);
                switch (c) {
                    case '"': b.append("\\\""); break;
                    case '\\': b.append("\\\\"); break;
                    case '\n': b.append("\\n"); break;
                    case '\r': b.append("\\r"); break;
                    case '\t': b.append("\\t"); break;
                    default:
                        if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                        else b.append(c);
                }
            }
            return b.append('"').toString();
        }
    }
}
