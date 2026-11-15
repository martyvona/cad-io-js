/* Exempts predicates.c's known out-of-bounds reads from AddressSanitizer by function name, without editing the file
   (README.md): build.sh's test mode compiles predicates.c with -include of this header, and GCC and clang merge an
   earlier declaration's attributes into its K&R definition. Only the functions the tests show reading past an
   expansion's end are listed; any other overflow in the file still stops the run. */
__attribute__((no_sanitize_address)) int fast_expansion_sum_zeroelim();
