namespace Ascentix.RulesEngine.Core.Models
{
    /// <summary>Discriminates a node-filter criterion: a scalar field comparison, or an EXISTS
    /// predicate over a related child collection.</summary>
    public enum CriterionKind { Comparison = 1, Exists = 2 }
}
