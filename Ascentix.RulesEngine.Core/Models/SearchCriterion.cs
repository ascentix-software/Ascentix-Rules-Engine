namespace Ascentix.RulesEngine.Core.Models
{
    /// <summary>
    /// A single in-memory filter criterion.
    /// Operator values: eq, ne, like, not-like, null, not-null, contains, not-contains
    /// For multi-select optionsets, Value is comma-separated integers e.g. "1,2,3"
    /// </summary>
    public class SearchCriterion
    {
        public string FieldName { get; set; }
        public string Operator { get; set; }
        public string Value { get; set; }
    }
}
